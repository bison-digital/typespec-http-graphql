import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * `@friendlyName` on a template, on a template spreading its argument, and on a declaration: each
 * names its type in the OpenAPI document, the validators and the GraphQL schema alike.
 */
@service
namespace Friendly;

model Widget {
  id: string;
}

@friendlyName("{name}Box", T)
model Box<T> {
  item: T;
}

@friendlyName("Gizmo")
model Gadget {
  id: string;
  /** A friendly-named instance as an argument of a composed one. */
  boxes: Shelf<Box<Widget>>;
}

model Shelf<T> {
  items: T[];
}

@error
model Conflict {
  @statusCode _: 409;
  message: string;
}

@friendlyName("Located{name}", P)
model Located<P extends {}> {
  ...P;
  @header location?: string;
}

@route("/widgets")
interface Widgets {
  @get read(@path id: string): Box<Widget>;
  @post create(@body body: Widget): { @statusCode _: 201; @body body: Widget } | Located<Conflict>;
}

@route("/gadgets")
interface Gadgets {
  @get read(@path id: string): Gadget;
}

@@queryField(Widgets.read, "widgetBox");
@@queryField(Gadgets.read, "gadget");
@@mutationField(Widgets.create, "createWidget");
