import "@typespec/http";

using Http;

/**
 * Bodies declared `never`, which `typespec-http-zod` refuses (`never-body`): `@typespec/openapi3`
 * publishes one as any JSON value. An emit carries on past a library's error, so this emitter still
 * plans each operation, and passes over such a body as the library does, declaring no schema for it.
 */
@service(#{ title: "Nevers" })
namespace Nevers;

model Widget {
  id: string;
}

model Nevered {
  @statusCode _: 200;
  @body body: never;
}

model Found {
  @statusCode _: 200;
  @body body: Widget;
}

@error model Gone {
  @statusCode _: 410;
  @body body: never;
}

@route("/widgets")
interface Widgets {
  @get @route("/nevered") nevered(): Nevered | Found;
  @get @route("/gone") gone(): Widget | Gone;
}
