import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

// One anonymous type two declared models hold through an alias, and one two models inherit from an
// instance whose composed name leaves out its argument. Each is one GraphQL type, named after the
// first holder declared, though `graphql.tsp` reaches the other first.
@service(#{ title: "Shared" })
namespace Shared;

alias Tone = "warm" | "cool";

model Lamp {
  id: string;
  tone: Tone;
}

model Paint {
  id: string;
  tone: Tone;
}

model Crate<T> {
  contents: {
    item: T;
  };
}

model Low extends Crate<"x"> {
  id: string;
}

model High extends Crate<"x"> {
  id: string;
}

@route("/paints/{id}") @get op readPaint(@path id: string): Paint;
@route("/lamps/{id}") @get op readLamp(@path id: string): Lamp;
@route("/highs/{id}") @get op readHigh(@path id: string): High;
@route("/lows/{id}") @get op readLow(@path id: string): Low;

@@queryField(readPaint, "paint");
@@queryField(readLamp, "lamp");
@@queryField(readHigh, "high");
@@queryField(readLow, "low");
