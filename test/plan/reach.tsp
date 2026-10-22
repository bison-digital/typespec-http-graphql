// Links that become reachable only through other links, and one whose parent never does.
import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

@service(#{ title: "Reach" })
namespace Reach;

model Widget {
  id: string;
  gadgetId: string;
}

model Gadget {
  id: string;
  partId: string;
}

model Part {
  id: string;
}

model Orphan {
  thingId: string;
}

model Thing {
  id: string;
}

@route("/widgets/{id}") @get op readWidget(@path id: string): Widget;
@route("/gadgets/{id}") @get op readGadget(@path id: string): Gadget;
@route("/parts/{id}") @get op readPart(@path id: string): Part;
@route("/things/{id}") @get op readThing(@path id: string): Thing;

@@queryField(readWidget, "widget");
@@link(Widget, "gadget", readGadget, #{ id: "gadgetId" });
@@link(Gadget, "part", readPart, #{ id: "partId" });
@@link(Orphan, "thing", readThing, #{ id: "thingId" });
