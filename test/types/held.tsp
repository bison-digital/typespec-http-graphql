import "@typespec/http";

using Http;

/**
 * Members holding one alias's type, where the first model declared names a later one: the checker
 * files `Paint` when it checks `Easel`, before `Lamp`, which is declared ahead of it.
 */
@service
namespace Held;

alias Tone = "warm" | "cool";

model Easel {
  paint: Paint;
}

model Lamp {
  tone: Tone;
}

model Paint {
  tone: Tone;
}

@route("/easels")
op read(): Easel;

@route("/lamps")
op lamp(): Lamp;
