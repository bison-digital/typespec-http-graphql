import "@typespec/http";

using Http;

/**
 * Shapes `typespec-http-zod` refuses with an error of its own. An emit carries on past a library's
 * error, so this emitter still projects each, and must neither throw nor loop: a scalar whose
 * `@encode` names itself recursed for ever without the guard in `types.ts`.
 */
@service(#{ title: "Refused" })
namespace Refused;

@encode("rfc7231")
scalar Stamp extends utcDateTime;

// A scalar whose own `@encode` names itself, so states no other wire type (`unsatisfiable-encoding`).
@encode("x-custom", Selfish)
scalar Selfish extends string;

model Encodings {
  // An encoding naming a scalar that is not a standard one (`unsatisfiable-encoding`).
  @encode("x-custom", Stamp) stamp: Stamp;
  selfish: Selfish;
}

// Types that are no declaration (`unsupported-type`).
model Odd {
  template: "a-${"b"}";
  hollow: void;
}

model Circle {
  kind: "circle";
  radius: float64;
}

model Square {
  kind: "square";
  side: float64;
}

// An unnamed variant is the default, which carries no discriminator value (`unsupported-type`).
@discriminated
union Fallback {
  circle: Circle,
  Square,
}

// A variant that is a list, which TypeSpec accepts without an envelope (`undeclared-discriminator`).
@discriminated(#{ envelope: "none" })
union Bundle {
  circle: Circle,
  many: Circle[],
}

// A subtype named as another type is (`duplicate-declaration`): the library refuses both whole, and
// publishes a validator for neither, a nested base among them.
@discriminator("kind")
model Beast {
  kind: string;
  name: string;
}

model Wolf extends Beast {
  kind: "wolf";
  howl: string;
}

model Bear extends Beast {
  kind: "bear";
  claws: int32;
}

@discriminator("sort")
model Canine extends Beast {
  kind: "canine";
  sort: string;
}

model Coyote extends Canine {
  sort: "coyote";
  yip: boolean;
}

namespace Elsewhere {
  model Wolf {
    pack: int32;
  }

  model Canine {
    den: string;
  }
}
