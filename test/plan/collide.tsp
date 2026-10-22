// Two models whose names differ in TypeSpec and convert to one GraphQL name, each reached by its own
// root field. Two models of one name cannot meet here: the library refuses them first
// (`duplicate-declaration`).
import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

@service(#{ title: "Collide" })
namespace Collide;

model Widget {
  id: string;
}

model GadgetKind {
  id: string;
}

model gadget_kind {
  serial: int32;
}

@route("/widgets") @get op readWidget(): Widget;
@route("/gadgets") @get op readGadget(): GadgetKind;
@route("/other-gadgets") @get op readOtherGadget(): gadget_kind;

@@queryField(readWidget, "widget");
@@queryField(readGadget, "gadget");
@@queryField(readOtherGadget, "otherGadget");
