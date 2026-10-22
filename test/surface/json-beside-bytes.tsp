import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@queryField(Widgets.read, "widget");
@@queryField(Widgets.list, "widgets");

// One status, offered as JSON or as bytes. The handler chooses which, so its result type carries
// the bytes, and GraphQL could not project them: refused, though JSON is on offer.
@@queryField(Widgets.archive, "widgetArchive");
