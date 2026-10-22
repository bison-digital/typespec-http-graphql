import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A create body that differs from its model only by read-only properties, so `@typespec/openapi3`
 * publishes the request as the model's canonical schema: `Widget`, its `id` in `required` and
 * `readOnly`, and its `part`'s `Part` the same. Compiled at openapi3's default, OpenAPI 3.0, and at
 * 3.1, which read that `required` differently in a request.
 */
@service(#{ title: "Read-only" })
namespace ReadOnly;

model Part {
  @visibility(Lifecycle.Read) id: string;
  sku: string;
}

model Widget {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  part: Part;
}

@route("/widgets") @post op create(@body widget: Widget): Widget;

@@mutationField(create, "createWidget");
