import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A service as it stands, and, behind each `EVOLVE:<name>` comment, one change a REST API makes
 * without breaking its clients: `evolution.test.ts` compiles each by uncommenting its marker. The
 * `CONTROL:` line is the one change that must break: it removes a property.
 */
@service(#{ title: "Evolution" })
namespace Evolution;

model Widget {
  id: string;
  name: string;
  // EVOLVE:optional-property colour?: string;
  // EVOLVE:deprecate #deprecated "use name"
  label?: string;
  size: int32; // CONTROL:remove-property
}

/** What the evolution `add-operation` answers. Unreachable, so absent from the schema, until then. */
model Count {
  total: int32;
}

@error
model Conflict {
  @statusCode _: 409;
  message: string;
}

@error
model Missing {
  @statusCode _: 404;
  message: string;
}

@route("/widgets")
interface Widgets {
  @get
  @route("/{id}")
  read(@path id: string /* EVOLVE:optional-query-param , @query since?: string */): Widget /* EVOLVE:add-query-error-response | Missing */;

  @post
  create(@body body: Widget /* EVOLVE:optional-mutation-param , @query dryRun?: boolean */): Widget /* EVOLVE:add-error-response | Conflict */;

  // EVOLVE:add-operation @get @route("/count") count(): Count;
}

@@queryField(Widgets.read, "widget");
@@mutationField(Widgets.create, "createWidget");
// EVOLVE:add-operation @@queryField(Widgets.count, "widgetCount");
