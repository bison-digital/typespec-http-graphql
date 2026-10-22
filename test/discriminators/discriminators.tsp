import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * `@discriminator` bases, each read by one operation: what REST serves for a value, and what
 * GraphQL answers for it.
 */
@service(#{ title: "Kennel" })
namespace Kennel;

/** An extensible discriminator: a kind no subtype names is a `Dog`. */
union DogKind {
  string,
  Golden: "golden",
}

@discriminator("kind")
model Dog {
  kind: DogKind;
  weight: int32;
}

/** A subtype that adds a property. */
model Golden extends Dog {
  kind: DogKind.Golden;
  coat: string;
}

/** A fixed discriminator: only `cobra` is a kind. */
enum SnakeKind {
  cobra,
}

@discriminator("kind")
model Snake {
  kind: SnakeKind;
  length: int32;
}

model Cobra extends Snake {
  kind: SnakeKind.cobra;
  hood: boolean;
}

@discriminator("kind")
model Pet {
  kind: string;
  age: int32;
}

/** A subtype that only narrows a property its base declares. */
model Puppy extends Pet {
  kind: "puppy";
  @maxValue(1) age: int32;
}

@discriminator("kind")
model Fish {
  kind: string;
  age: int32;
}

model Salmon extends Fish {
  kind: "salmon";
  river: string;
}

/** A base under a base, with a discriminator of its own. */
@discriminator("sharktype")
model Shark extends Fish {
  kind: "shark";
  sharktype: string;
}

model SawShark extends Shark {
  sharktype: "saw";
  teeth: int32;
}

/**
 * A base whose own declaration of the discriminator is sent as another key: openapi3 publishes
 * `Animal` with `type` and the `kind` it adds, its `discriminator.propertyName` `kind`, and `Bird` as
 * `Animal` and its own `kind`.
 */
@discriminator("kind")
model Animal {
  @encodedName("application/json", "type") kind: string;
  legs: int32;
}

model Bird extends Animal {
  kind: "bird";
  wings: int32;
}

@route("/dog") @get op dog(@query which: string): Dog;
@route("/snake") @get op snake(@query which: string): Snake;
@route("/pet") @get op pet(@query which: string): Pet;
@route("/fish") @get op fish(@query which: string): Fish;
@route("/shark") @get op shark(@query which: string): Shark;
@route("/animal") @get op animal(@query which: string): Animal;

@@queryField(dog, "dog");
@@queryField(snake, "snake");
@@queryField(pet, "pet");
@@queryField(fish, "fish");
@@queryField(shark, "shark");
@@queryField(animal, "animal");
