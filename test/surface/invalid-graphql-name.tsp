import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@queryField(Widgets.read, "widget");
@@queryField(Widgets.list, "list-widgets");
@@mutationField(Widgets.create, "__createWidget");
@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });
@@link(Widget, "author of", Authors.read, #{ authorId: "authorId" });
