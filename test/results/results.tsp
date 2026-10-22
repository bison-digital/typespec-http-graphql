import "@typespec/http";

using Http;

/**
 * One operation per row of `design.md` § Results.
 */
@service(#{ title: "Results" })
namespace Results;

model Widget {
  id: string;
}

@error model NotFound {
  @statusCode _: 404;
  message: string;
}

@error model Problem {
  @statusCode @minValue(400) @maxValue(499) status: int32;
  detail: string;
}

@error model Invalid {
  @statusCode _: 400 | 422;
  detail: string;
}

@error model Conflict {
  @statusCode _: 409;
  message: string;
}

@error model Gone {
  @statusCode _: 410;
}

@error model Unauthorized {
  @statusCode _: 401;
}

@error model Forbidden {
  @statusCode _: 403;
}

@error model Throttled {
  @statusCode _: 429;
  @header("Retry-After") retryAfter?: int32;
}

@error model Broken {
  @statusCode _: 500;
  message: string;
}

@error model Unavailable {
  @statusCode _: 503;
}

@error model Outage {
  @statusCode @minValue(500) @maxValue(599) status: int32;
}

@error model Fallback {
  message: string;
}

model Moved {
  @statusCode _: 302;
  @header location: string;
}

model NoContent {
  @statusCode _: 204;
}

model Partial {
  @statusCode _: 206;
  @body body: Widget[];
}

model Created {
  @statusCode _: 201;
  @body body: Widget;
}

model Gadget {
  serial: string;
}

model GadgetMade {
  @statusCode _: 201;
  @body body: Gadget;
}

// A body declared `void` is none: the document publishes the status's other body.
model Voided {
  @statusCode _: 200;
  @body body: void;
}

model Found {
  @statusCode _: 200;
  @body body: Widget;
}

model MaybeWidgets {
  @statusCode _: 201;
  @body body: (Widget | null)[];
}

model Informing {
  @statusCode @minValue(100) @maxValue(199) status: int32;
  note: string;
}

model AnySuccess {
  @statusCode @minValue(200) @maxValue(299) status: int32;
  @body body: Widget;
}

@error model Crash {
  @statusCode @minValue(500) @maxValue(599) status: int32;
  message: string;
}

@error model Failure {
  @statusCode @minValue(400) @maxValue(599) status: int32;
  reason: string;
}

@error model Lapse {
  @statusCode @minValue(400) @maxValue(499) status: int32;
}

@error model Lapsing {
  @statusCode @minValue(400) @maxValue(599) status: int32;
}

@error model Rejections {
  @body reasons: string[];
}

@error model Bare {
  @header("X-Reason") reason?: string;
}

@error model Expired {
  @statusCode _: 410;
  reason: string;
}

@route("/widgets")
interface Widgets {
  @get read(@path id: string):
    | Widget
    | NotFound
    | Invalid
    | Unauthorized
    | Forbidden
    | Conflict
    | Gone
    | Throttled
    | Broken
    | Unavailable;

  @get @route("/ranges") ranges(): Widget | Problem | Outage | Fallback | Moved;
  @get @route("/informed") informed(): Informing | AnySuccess;
  @get @route("/exists") exists(): NoContent;
  @get @route("/twice") twice(): Widget | Created;
  @get @route("/partly") partly(): Widget | Partial | NoContent;
  @get @route("/either") either(): Widget | GadgetMade;
  @get @route("/lists") lists(): Widget[] | MaybeWidgets;
  @get @route("/all") all(): Widget[];
  @get @route("/voided") voided(): Voided | Found;
  @get @route("/summary") summary(): {
    count: int32;
    either: Widget | Gadget;
  };

  @post create(@body body: Widget): Created | NotFound | Conflict | Invalid | Unauthorized | Throttled | Broken;
  @delete remove(@path id: string): NoContent | NotFound;
  @delete @route("/purge") purge(): NoContent | Gone;
  @delete @route("/archive") archive(): Widget | Gone | Expired;
  @post @route("/touch") touch(): NoContent;
  @put @route("/replace") replace(@body body: Widget): Widget;
  @post @route("/bulk") bulk(@body body: Widget[]): Widget[] | Conflict;
  @post @route("/tag") tag(): Record<string> | Conflict;
  @post @route("/ranged") ranged(): Widget | Problem;
  @post @route("/settle") settle(): Widget | Crash | Problem | Fallback;
  @post @route("/early") early(): Widget | Informing | Fallback;
  @post @route("/accept") accept(): AnySuccess | Conflict;
  @post @route("/overlap") overlap(): Widget | Failure | Problem;
  @post @route("/strict") strict(): Widget | Lapse | Rejections;
  @post @route("/bare") bare(): Widget | Bare;
  @post @route("/login") login(): Moved;
  @post @route("/devoid") devoid(): Voided | Found;
  @post @route("/lapse") lapse(): Widget | Lapsing | Problem;
  // A batch read: its body is the list a batched link's items are taken from.
  @get @route("/batch") batch(@query(#{ explode: true }) ids: string[]): {
    widgets: Widget[];
  } | NotFound | Invalid | Broken | Problem | NotModifiedResponse;
  @get @route("/batch-anonymous") batchAnonymous(@query(#{ explode: true }) ids: string[]): {
    id: string;
    label: string;
  }[];

  // Parts, for which the library declares no schema: surface.ts refuses it before planning.
  @get @route("/parts") parts(): {
    @header contentType: "multipart/form-data";
    @multipartBody body: { name: HttpPart<string> };
  };
}
