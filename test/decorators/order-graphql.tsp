import "typespec-http-graphql";
import "./order-rest.tsp";

using HttpGraphQL;
using Shop;

@@queryField(Widgets.read, "widget");
@@link(Widget, "gadget", Gadgets.read, #{ id: "gadget_id" });
