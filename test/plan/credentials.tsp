import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * Parameters that carry a credential by their standards, and one that is domain input: which of them
 * a field takes as an argument, and which are warned `transport-argument`.
 */
@service(#{ title: "Credentials" })
namespace Credentials;

model Account {
  id: string;
}

@route("/accounts")
interface Accounts {
  @get read(
    @path id: string,
    @header authorization: string,
    @cookie session: string,
    @cookie theme?: string,
    @header("x-api-version") apiVersion: string,
  ): Account;
}

@@queryField(Accounts.read, "account");
