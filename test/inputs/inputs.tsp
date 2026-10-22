import "@typespec/http";

using Http;

/**
 * Every rule of `design.md` § Arguments and input.
 */
@service(#{ title: "Inputs" })
namespace Inputs;

model Widget {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  @encodedName("application/json", "owner_id") ownerId: string;

  /** Free text. */
  note?: string;

  colour: "red" | "blue";
}

model Owner {
  id: string;
  name: string;
}

model PageRequest {
  /** How many to return. */
  @query @pageSize @maxValue(200) limit?: int32 = 50;

  @query @continuationToken cursor?: string;
}

model WidgetPage {
  @pageItems items: Widget[];
  @continuationToken @encodedName("application/json", "nextCursor") next_cursor?: string;
}

model SearchFilter {
  text: string;
  tags?: string[];
}

/** A body whose additional properties are keys of the handler's input itself. */
model Labels extends Record<unknown> {
  name: string;
}

@route("/widgets")
interface Widgets {
  @get read(
    @path widgetId: string,
    @header("If-None-Match") ifNoneMatch?: string,
    @header("X-Request-Id") requestId?: string,
    @header("X-Api-Version") apiVersion: string,
    @cookie session?: string,
  ): Widget;

  @list @get list(...PageRequest, @query("page-size") pageSize?: int32, @query state?: "open" | "closed"): WidgetPage;

  /** Paging parameters after a filter, and a continuation token with a default. */
  @list @get @route("/find") find(
    @query q?: string,

    /** How many widgets to return. */
    @query @pageSize size?: int32 = 20,

    @query @continuationToken from?: string = "start",
  ): WidgetPage;

  @post @route("/search") search(@query limit?: int32, @body filter: SearchFilter): Widget[];

  @post create(@body body: Widget): Widget;

  @patch update(
    @path widgetId: string,
    @header contentType: "application/merge-patch+json",
    @header("If-Match") ifMatch: string,
    @body body: Widget,
  ): Widget;

  /** A body sharing a key with a path parameter, which the library names rather than spreads. */
  @put @route("/names/{name}") rename(
    @path name: string,

    /** The widget's new name. */
    @body body: {
      name: string;
    },
  ): Widget;

  /** An implicit body, of the unannotated `note`, sharing its key with the query parameter. */
  @post @route("/notes") annotate(@query("note") q?: string, note: string): Widget;

  @post @route("/ping") ping(): void;

  /** Parts, which surface.ts refuses before planning (`non-json-request`). */
  @post @route("/upload") upload(
    @header contentType: "multipart/form-data",
    @multipartBody body: [HttpPart<string, #{ name: "note" }>],
  ): Widget;
}

@route("/owners")
interface Owners {
  @get read(@path ownerId: string, @query verbose?: boolean, @query view?: "brief" | "full"): Owner;
  @post @route("/{region}") create(@path region: string, @body body?: Owner): Owner;
  @put @route("/{region}/profile") replace(@path region: string, @body body: Owner | null): Owner;
}

@route("/labels")
interface Labelled {
  @post @route("/search") search(@query limit?: int32, @body labels: Labels): Widget[];
  @post label(@header("X-Api-Version") apiVersion: string, @body labels: Labels): Widget;
}

@route("/reports")
interface Reports {
  @sharedRoute @get asJson(@header accept: "application/json", @query version: "2026-10-01"): Owner;
  @sharedRoute @get asText(@header accept: "text/plain"): {
    @header contentType: "text/plain";
    @body body: string;
  };
}

scalar Stamp extends utcDateTime;

/** A date-time header with no `@encode` is sent as RFC 7231, as `@typespec/openapi3` publishes it. */
model Stamped {
  @header("If-Unmodified-Since") since: utcDateTime;
  name: string;
}

@route("/stamps")
interface Stamps {
  @get read(
    @header("X-Since") since: utcDateTime,
    @header("X-Offset") offset: offsetDateTime,
    @header("X-Iso") @encode(DateTimeKnownEncoding.rfc3339) iso: utcDateTime,
    @header("X-Human") @encode(DateTimeKnownEncoding.rfc7231) human: utcDateTime,
    @header("X-Stamp") stamp: Stamp,
    @header("X-Stamps") stamps: utcDateTime[],
    @header("X-Maybe") maybe: utcDateTime | null,
    @query at: utcDateTime,
  ): Owner;

  @post touch(@bodyRoot body: Stamped): Owner;
}
