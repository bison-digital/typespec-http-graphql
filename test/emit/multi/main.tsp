import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * Three services in one program. Two declare a GraphQL surface; the third declares none, so it gets
 * the library's validators, no GraphQL file, and a `no-fields-declared` warning naming it.
 */
@service(#{ title: "Widgets" })
namespace Widgets {
  model Widget {
    id: string;
    name: string;
  }

  @route("/widgets/{widgetId}")
  @get
  op readWidget(@path widgetId: string): Widget;
}

@service(#{ title: "Gadgets" })
namespace Gadgets {
  model Gadget {
    id: string;
    weight: int32;
  }

  @route("/gadgets/{gadgetId}")
  @get
  op readGadget(@path gadgetId: string): Gadget;
}

@service(#{ title: "Gizmos" })
namespace Gizmos {
  model Gizmo {
    id: string;
  }

  @route("/gizmos/{gizmoId}")
  @get
  op readGizmo(@path gizmoId: string): Gizmo;
}

@@queryField(Widgets.readWidget, "widget");
@@queryField(Gadgets.readGadget, "gadget");
