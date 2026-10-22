// Models first, then interfaces, and a link from a model to an interface declared after it. The
// link's operation argument is checked with the model, so the checker meets `Gadgets` first.
import "@typespec/http";

using Http;

@service
namespace Shop;

model Widget {
  id: string;
  gadget_id: string;
}
model Gadget {
  id: string;
  label: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/status")
interface Status {
  @get read(): {
    @statusCode _: 200;
    ok: boolean;
  };
}
@route("/widgets")
interface Widgets {
  @get read(@path id: string): Widget | NotFound;
}
@route("/gadgets")
interface Gadgets {
  @get read(@path id: string): Gadget | NotFound;
}
