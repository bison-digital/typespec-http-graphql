import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@queryField(Widgets.read, "widget");
@@queryField(Widgets.export, "exportWidgets");
@@queryField(Widgets.download, "downloadWidgets");
// A multipart response, for which the library declares no schema: parts, which no type projects.
@@queryField(Widgets.parts, "widgetParts");
// An error body declared `void`, at a code or a range, is no body: kept. A multipart error body is
// parts: dropped.
@@queryField(Widgets.voided, "voidedWidget");
@@queryField(Widgets.voidRange, "voidRangeWidget");
@@queryField(Widgets.partsConflict, "partsConflictWidget");
// JSON beside XML in one status: the handler may answer XML, so this is refused too.
@@queryField(Widgets.formats, "widgetFormats");
