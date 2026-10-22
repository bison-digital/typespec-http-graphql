import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@queryField(Widgets.read, "widget");
// A search by POST: a warning, and still a field.
@@queryField(Widgets.search, "searchWidgets");
