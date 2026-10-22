import "@typespec/http";
import "./ordered-first.tsp";
import "./ordered-second.tsp";

using Http;

/**
 * Two models holding one alias, each in a file of its own: the file imported first declares first,
 * however far into it its model sits.
 */
@service(#{ title: "Ordered" })
namespace Ordered;

alias Tone = "warm" | "cold";

@route("/lamps")
interface Lamps {
  @get @route("/lamp") lamp(): Lamp;
  @get @route("/paint") paint(): Paint;
}
