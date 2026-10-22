// The REST service every single-diagnostic fixture in this directory declares a surface over.
import "@typespec/http";

using Http;

@service(#{ title: "Surface" })
namespace Surface;

model Author {
  @key id: string;
  name: string;
}

model Widget {
  @key id: string;
  authorId: string | null;
  count: int32;
  display_name: string;
  @encodedName("application/json", "made_on") createdAt: utcDateTime;
}

// A book signing. Its `authorId` is written on create and never read back, and its `etag` is a
// header, so neither is in the body a link's parent value is.
model Signing {
  @key id: string;
  @visibility(Lifecycle.Create) authorId: string;
  @header etag: string;
  readAuthorId: string;
}

model Gadget extends Widget {
  label: string;
}

model WidgetFilter {
  prefix: string;
}

@discriminator("kind")
model Pet {
  kind: string;
}

model Cat extends Pet {
  kind: "cat";
  meows: boolean;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

/**
 * Error bodies declared `void`: the library lists no media type for one, and `@typespec/openapi3`
 * publishes its status with no content. A multipart one is parts.
 */
@error model VoidConflict {
  @statusCode _: 409;
  @body body: void;
}
@error model VoidServerError {
  @minValue(500) @maxValue(599) @statusCode _: int32;
  @body body: void;
}
@error model PartsConflict {
  @statusCode _: 409;
  @header contentType: "multipart/form-data";
  @multipartBody body: { name: HttpPart<string> };
}

@route("/authors")
interface Authors {
  @get read(@path authorId: string): Author | NotFound;
  @route("/by-number") @get byNumber(@path number: int64): Author | NotFound;
}

@route("/widgets")
interface Widgets {
  @get read(@path id: string): Widget | NotFound;
  @get list(@query authorId?: string): Widget[];
  @post create(@body body: Widget): Widget;
  @route("/search") @post search(@body filter: WidgetFilter): Widget[];
  @route("/touch") @post touch(@path id: string): Widget;
  @head exists(@path id: string): void;
  @route("/find") @get find(@query q: string, @body filter: WidgetFilter): Widget[];
  @route("/upload") @post upload(@header contentType: "text/plain", @body body: string): Widget;
  @route("/form") @post form(
    @header contentType: "multipart/form-data",
    @multipartBody body: { name: HttpPart<string> },
  ): Widget;
  @route("/xml") @post xml(@header contentType: "application/xml", @body body: Widget): Widget;
  @route("/blob") @post blob(@header contentType: "application/octet-stream", @body body: bytes): Widget;
  @route("/either") @post either(
    @header contentType: "application/json" | "application/xml",
    @body body: Widget,
  ): Widget;
  @route("/export") @get export(): {
    @header contentType: "text/csv";
    @body body: string;
  };
  @route("/download") @get download(): {
    @header contentType: "application/octet-stream";
    @body body: bytes;
  };
  @route("/parts") @get parts(): {
    @header contentType: "multipart/form-data";
    @multipartBody body: { name: HttpPart<string> };
  };
  @route("/tally") @post tally(@header contentType: "application/json", @bodyRoot body: int32): Widget;
  @route("/batch") @post batch(@bodyRoot widgets: Widget[]): Widget[];
  @route("/adopt") @post adopt(@bodyRoot pet: Pet): Pet;
  @route("/match") @get match(@bodyRoot pet: Pet): Author;
  @route("/archive") @get archive(): {
    @header contentType: "application/json" | "application/octet-stream";
    @body body: Widget;
  };
  @route("/voided") @get voided(): Widget | VoidConflict;
  @route("/void-range") @get voidRange(): Widget | VoidServerError;
  @route("/parts-conflict") @get partsConflict(): Widget | PartsConflict;
  @route("/formats") @get formats(): {
    @header contentType: "application/json" | "application/xml";
    @body body: Widget;
  };
}

/**
 * Parameters the handler's input carries under one key: the input is one object keyed by wire
 * name, wherever each parameter is sent. `distinct` shares a location, not a name.
 */
@route("/shared")
interface Shared {
  @route("/header") @get header(@header("x") inHeader: string, @query("x") inQuery: string): Widget;
  @route("/query") @get query(@query("x") first?: string, @query("x") second?: string): Widget;
  @route("/path/{id}") @get path(@path id: string, @header("id") inHeader: string): Widget;
  @route("/cookie") @get cookie(@cookie("x") inCookie?: string, @query("x") inQuery?: string): Widget;
  @route("/body") @post body(@query("body") inQuery: string, @bodyRoot body: string[]): Widget;
  @route("/distinct") @get distinct(@header("x") inHeader: string, @query("y") inQuery: string): Widget;
}
