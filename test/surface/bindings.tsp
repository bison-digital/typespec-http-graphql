// Every kind of parameter a link can fill, each with a wire name that differs from its TypeSpec name.
import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

@service(#{ title: "Bindings" })
namespace Bindings;

model Thing {
  @key id: string;
}

model Holder {
  @encodedName("application/json", "thingRef") thing_ref: string;
  size: int32;
  requestId: string;
  session: string;
}

@route("/things/{thing_id}")
@get
op read(
  @path thing_id: string,
  @query("page-size") page_size?: int32,
  @header("x-request-id") request_id?: string,
  @cookie session?: string,
): Thing;

@@link(Holder, "thing", read, #{
  thing_id: "thing_ref",
  page_size: "size",
  request_id: "requestId",
  session: "session",
});
