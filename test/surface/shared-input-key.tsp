import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

// Two inputs under one key of the handler's input, wherever each is sent: dropped.
@@queryField(Shared.header, "headerAndQuery");
@@queryField(Shared.query, "twoQueries");
@@queryField(Shared.path, "pathAndHeader");
@@queryField(Shared.cookie, "cookieAndQuery");
@@mutationField(Shared.body, "queryAndBody");
@@link(Widget, "shared", Shared.header, #{ inQuery: "id" });

// One location, two names: kept.
@@queryField(Shared.distinct, "distinct");
@@queryField(Widgets.read, "widget");
