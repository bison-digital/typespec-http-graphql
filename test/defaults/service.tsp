import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

@service(#{ title: "Defaults" })
namespace Defaults;

model Widget {
  id: string;
  name: string;
}

@route("/widgets/{id}") @get op read(@path id: string): Widget;

@@queryField(read, "widget");
