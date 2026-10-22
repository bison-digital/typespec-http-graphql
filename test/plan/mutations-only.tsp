// A surface that declares a mutation and no query.
import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

@service(#{ title: "Writes" })
namespace Writes;

model Widget {
  id: string;
  name: string;
}

@route("/widgets") @post op createWidget(@body body: Widget): Widget;

@@mutationField(createWidget, "createWidget");
