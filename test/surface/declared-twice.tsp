import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@queryField(Widgets.read, "widget");
@@queryField(Widgets.read, "widgetAgain");
@@mutationField(Widgets.read, "readWidget");
@@queryField(Widgets.list, "widgets");
