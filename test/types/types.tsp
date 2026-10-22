import "@typespec/http";

using Http;

/**
 * One of every shape `design.md` § Types has a rule for.
 */
@service(#{ title: "Shapes" })
namespace Shapes;

model Base {
  @visibility(Lifecycle.Read) id: string;

  /** The display name. */
  name: string;
}

/** A widget. */
model Widget extends Base {
  #deprecated "use hue"
  color?: string;

  @encodedName("application/json", "created_at") createdAt: utcDateTime;
  @header etag?: string;
  @visibility(Lifecycle.Create) secret: string;
  tags: string[];
  maybe: (string | null)[];
  nested: {
    inner: string;
    deep: {
      depth: int32;
    };
  };
  labels: Record<string>;
  anything: unknown;
  status: Status;
  priority: Priority;
  stage: "in-progress" | "done";
  open: "a" | "b" | string;
  gadget: Gadget | null;
  either: string | int32;
}

model Gadget {
  id: string;
}

/**
 * An open model as a source: `AjarBase` carries additional properties of its own, `Ajar` extends it,
 * and the two spreading `Ajar` are closed (a spread copies `Ajar`'s properties, not its base's
 * indexer), so they share `Ajar`, and `AjarBase` too, transitively.
 */
model AjarBase is Record<string> {
  label: string;
}

model Ajar extends AjarBase {
  note: string;
}

model AjarOne {
  ...Ajar;
  one: string;
}

model AjarTwo {
  ...Ajar;
  two: string;
}

/** The one type built from `Gadget`, by spread, beside `Copies.gadget`, which is `Gadget` itself. */
model GadgetPlus {
  ...Gadget;
  extra: string;
}

/**
 * Converts to the same GraphQL name as `Gadget`, under a validator name of its own (`gadget_Schema`):
 * `gadget` would share `gadgetSchema` with it, which `typespec-http-zod` refuses.
 */
model gadget_ {
  serial: int32;
}

enum Status {
  /** Under way. */
  InProgress: "in-progress",

  Done: "done",
}

enum Priority {
  Low: 1,
  High: 2,
}

// Two members whose values convert to one GraphQL name.
enum Clash {
  inProgress: "a",
  in_progress: "b",
}

/** Converts to the same GraphQL name as `Status`, under a validator name of its own. */
enum status_ {
  Other: "other",
}

scalar Slug extends string;

@encode("rfc7231")
scalar Stamp extends utcDateTime;

// Inherits `Stamp`'s encoding through its base.
scalar Stamped extends Stamp;

// Extends no standard scalar, so GraphQL has no type to give it.
scalar Opaque;

model Scalars {
  s: string;
  b: boolean;
  i8: int8;
  i16: int16;
  i32: int32;
  u8: uint8;
  u16: uint16;
  f: float;
  f32: float32;
  f64: float64;
  i64: int64;
  u32: uint32;
  si: safeint;
  u64: uint64;
  int: integer;
  num: numeric;
  d: decimal;
  d128: decimal128;
  utc: utcDateTime;
  @encode("rfc7231") utcHuman: utcDateTime;
  @encode("unixTimestamp", int64) utcUnix: utcDateTime;
  /** A standard scalar of its own, `utcDateTime` encoded as Unix seconds in an int32. */
  unix32: unixTimestamp32;
  off: offsetDateTime;
  @encode("rfc7231") offHuman: offsetDateTime;
  date: plainDate;
  time: plainTime;
  dur: duration;
  @encode("seconds", int32) durSeconds: duration;
  @encode("milliseconds", int32) durMilliseconds: duration;
  raw: bytes;
  @encode("base64url") rawUrl: bytes;
  link: url;
  slug: Slug;
  stamp: Stamp;
  stamped: Stamped;
  @encode("x-custom") custom: string;
  @encode(string) bigText: int64;
}

// A scalar whose own `@encode` names another wire type: an `int64` on the wire.
@encode("x-custom", int64)
scalar Wide extends int32;

// A scalar that extends no standard scalar: `JSON` alone, the type an `@encode` states otherwise.
scalar Unbased;

// The encoding each standard scalar has with no `@encode`, named; a custom encoding whose wire type
// is a scalar with an encoding of its own; an ISO 8601 duration stated as an `int32`, which the
// compiler accepts (`validateEncodeData` names no ISO 8601 case), beside seconds as a `float32`;
// and the scalars above.
model Encodings {
  @encode("rfc3339") utc: utcDateTime;
  @encode(DateTimeKnownEncoding.rfc3339) off: offsetDateTime;
  @encode(DurationKnownEncoding.ISO8601) dur: duration;
  @encode(BytesKnownEncoding.base64) raw: bytes;
  @encode(DurationKnownEncoding.ISO8601, int32) isoCount: duration;
  @encode(DurationKnownEncoding.seconds, float32) secs: duration;
  @encode(DurationKnownEncoding.ISO8601, Unbased) unbasedIso: duration;
  @encode("x-custom", string) unbasedText: Unbased;
  wide: Wide;
}

// Every numeric and boolean scalar under `@encode(string)`, whose wire form is then a JSON string.
model StringEncoded {
  @encode(string) b: boolean;
  @encode(string) i8: int8;
  @encode(string) i16: int16;
  @encode(string) i32: int32;
  @encode(string) u8: uint8;
  @encode(string) u16: uint16;
  @encode(string) f: float;
  @encode(string) f32: float32;
  @encode(string) f64: float64;
  @encode(string) i64: int64;
  @encode(string) u32: uint32;
  @encode(string) si: safeint;
  @encode(string) u64: uint64;
  @encode(string) int: integer;
  @encode(string) num: numeric;
  @encode(string) d: decimal;
  @encode(string) d128: decimal128;
}

// Types that are no declaration: literals, and the intrinsics.
model Odd {
  flag: true;
  small: 5;
  fraction: 1.5;
  intMax: 2147483647;
  pastIntMax: 2147483648;
  intMin: -2147483648;
  pastIntMin: -2147483649;
  nothing: null;
  pair: [string, int32];
  opaque: Opaque;
  @encode(ArrayEncoding.commaDelimited) csv: string[];
  /** Encodings TypeSpec does not name: the library validates the wire type `@encode` states. */
  @encode("x-custom", string) customCount: int32;
  @encode("x-custom") customList: string[];
  items: {
    label: string;
  }[];
}

// A date-time with no `@encode` is RFC 7231 as a header's own type, alone or with `| null`, and
// RFC 3339 otherwise: a declared scalar, a list's items, a variant of a wider union, an `@encode`.
scalar Instant extends utcDateTime;

model Headers {
  @header since: utcDateTime;
  @header until: offsetDateTime | null;
  @header instant: Instant;
  @header seen: utcDateTime[];
  @header either: utcDateTime | string;
  @header @encode("rfc3339") explicit: utcDateTime;
}

// A query parameter's array encoding is its style; any other parameter `@encode` is its wire type.
model Params {
  @query @encode(ArrayEncoding.commaDelimited) tags: string[];
  @query @encode("x-custom", string) code: int32;
  @query @encode(ArrayEncoding.commaDelimited) ids: int32[];
  @query @encode(ArrayEncoding.pipeDelimited) pipes: int32[];
  @query @encode(ArrayEncoding.spaceDelimited) spaces: int32[];
  @query @encode(ArrayEncoding.newlineDelimited) lines: int32[];
  @query plain: int32[];
  @query @encode("x-custom", string) codes: int32[];
  @header @encode(ArrayEncoding.commaDelimited) xs: int32[];
  @path @encode(ArrayEncoding.commaDelimited) segs: string[];
}

// Unions of literals, of `null` alone, and of types neither literal nor discriminated.
union Nothing {
  null,
}

union Either {
  string,
  int32,
}

model Unions {
  level: 1 | 2;
  shade: "light" | "dark" | null;
  mood: Mood;
  nothing: Nothing;
  either: Either;
  again: Either;
}

// The models output types are built from, by `extends`, by spread or otherwise: the sources
// `defineInterfaces` may make an interface of. `Zeta`, `Alpha` and `Mid` are each shared by
// `ImplOne` and `ImplTwo`; `Measure` and `Labelled` keep only the fields every implementer projects
// alike, and `Quantity` none; `Root` reaches `DeepOne` and `DeepTwo` through `Middle`; `Solo` has
// one implementer.

/** The z-shaped part. */
model Zeta {
  /** The zeta. */
  z: string;
}

model Alpha {
  a: string;
  @encodedName("application/json", "alpha_code") code: string;
}

model Mid {
  m: string;
}

model ImplOne extends Zeta {
  ...Alpha;
  ...Mid;
  one: string;
}

model ImplTwo extends Zeta {
  ...Alpha;
  ...Mid;
  two: string;
}

model ImplThree extends Zeta {
  /** Its own zeta. */
  z: string;
}

model Measure {
  amount: numeric;
  unit: string;
}

model Count extends Measure {
  amount: int32;
}

model Ratio extends Measure {
  amount: float64;
}

model Quantity {
  amount: numeric;
}

model Whole extends Quantity {
  amount: int32;
}

model Part extends Quantity {
  amount: float64;
}

// A third, narrowing as the first does: one implementer narrowing differently still leaves it off.
model Piece extends Quantity {
  amount: int32;
}

model Labelled {
  label: string;
  note: string;
}

model Shown extends Labelled {
  shown: boolean;
}

model Hidden extends Labelled {
  @visibility(Lifecycle.Create) label: string;
  hidden: boolean;
}

alias Common = {
  common: string;
};

model AliasOne {
  ...Common;
  one: string;
}

model AliasTwo {
  ...Common;
  two: string;
}

model CopyOne is Alpha;
model CopyTwo is Alpha;

model Root {
  r: string;
}

model Middle extends Root {
  mm: string;
}

model DeepOne extends Middle {
  d1: string;
}

model DeepTwo extends Middle {
  d2: string;
}

model Solo {
  s: string;
}

model OnlySolo extends Solo {
  o: string;
}

// An `extends` and a spread that close a loop, which TypeSpec accepts (it refuses a loop of
// `extends` alone, or of spreads alone): each model is built from the other, and from no third.
model Clasp extends Hook {
  c: string;
}

model Hook {
  ...Clasp;
  h: string;
}

model OpenIs is Record<string> {
  a: string;
}

model OpenSpread {
  a: string;
  ...Record<string>;
}

// Bodies made only of one model's spread properties, which are that model on the wire.
// Anonymous types no declared model's member holds, inside an anonymous one: each is named by
// the hint a caller gives it, or by nothing.
model Adrift {
  held: {
    nested: {
      inner: string;
    };
    stage: "draft" | "final";
    spare: {
      label: string;
    };
  };
}

model Copies {
  gadget: {
    ...Gadget;
  };
  tree: {
    ...Tree;
  };
  spare: {
    label: string;
  };
}

// Deprecated properties: required with a doc, required without one, and optional and nullable.
model Retiring {
  /** The width. */
  #deprecated "use size"
  width: int32;

  #deprecated "use code"
  label: string;

  #deprecated "gone"
  note?: string | null;
}

// A default of every kind of value, each on the type it is stated in, or has no spelling in.
// A default from `status_`, whose GraphQL name collides with `Status`'s.
model EnumClash {
  status: status_ = status_.Other;
}

model Defaults {
  text: string = "hi";
  flag: boolean = true;
  count: int32 = 5;
  ratio: float64 = 1.5;
  whole: float64 = 2;
  big: int64 = 7;
  amount: decimal = 2.5;
  tiny: float64 = 0.1000000000000000000001;
  @encode(string) digits: int32 = 5;
  maybe: string | null = null;
  status: Status = Status.Done;
  shade: "light" | "dark" = "dark";
  tags: string[] = #["x"];
  stamp: utcDateTime = utcDateTime.fromISO("2020-01-01T00:00:00Z");
}

@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Shape {
  circle: Circle,
  square: Square,
}

@discriminated
union Wrapped {
  circle: Circle,
  square: Square,
}

/** An enveloped union whose variant is an anonymous model: named apart from its envelope. */
@discriminated
union Parcel {
  dot: {
    x: int32;
  },
  circle: Circle,
}

/** An enveloped union whose variant is the union itself, with no model between. */
@discriminated
union Nest {
  nest: Nest,
  circle: Circle,
}

model Circle {
  kind: "circle";
  radius: float64;
}

model Square {
  kind: "square";
  side: float64;
}

@discriminator("species")
model Pet {
  species: string;
  name: string;
}

model Cat extends Pet {
  species: "cat";
  lives: int32;
}

model Dog extends Pet {
  species: "dog";
  good: boolean;
}

// A union a variant refers back to, through a list.
@discriminated(#{ envelope: "none" })
union Expr {
  lit: Lit,
  sum: Sum,
}

model Lit {
  kind: "lit";
  value: int32;
}

model Sum {
  kind: "sum";
  terms: Expr[];
}

// Variants that are anonymous models, named from the union and the key.
@discriminated(#{ envelope: "none" })
union Inline {
  dot: {
    kind: "dot";
    size: int32;
  },
  box: {
    kind: "box";
    side: int32;
  },
}

// A variant that carries additional properties, so projects to no object type.
@discriminated(#{ envelope: "none" })
union Loose {
  open: OpenVariant,
  square: Square,
}

model OpenVariant {
  kind: "open";
  ...Record<string>;
}


// A hierarchy a derived model refers back to, through a list.
@discriminator("kind")
model Node {
  kind: string;
}

model Leaf extends Node {
  kind: "leaf";
}

model Branch extends Node {
  kind: "branch";
  children: Node[];
}

// The discriminator declared only by the derived models.
@discriminator("kind")
model Event {
  at: int32;
}

model Click extends Event {
  kind: "click";
  x: int32;
}

model Press extends Event {
  kind: "press";
  key: string;
}

// A base under a base, with a discriminator of its own; the root's discriminator a union of literals,
// optional as declared, which every subtype narrows to one.
@discriminator("kind")
model Vehicle {
  kind?: "car" | "boat";
  seats: int32;
}

@discriminator("fuel")
model Car extends Vehicle {
  kind: "car";
  fuel: string;
}

model Electric extends Car {
  fuel: "electric";
  range: int32;
}

model Boat extends Vehicle {
  kind: "boat";
}

// A derived model that carries additional properties, so projects to no object type.
@discriminator("kind")
model Loosened {
  kind: string;
}

model OpenDerived extends Loosened {
  kind: "open";
  ...Record<string>;
}

// A discriminator with nothing derived from it.
@discriminator("kind")
model Lonely {
  kind: string;
  note: string;
}

// Types named as GraphQL's own types are.
namespace Reserved {
  model Query {
    q: string;
  }

  model String {
    s: string;
  }

  model Duration {
    d: string;
  }

  enum Subscription {
    On,
  }

  union ID {
    "a",
    "b",
  }

  @discriminated(#{ envelope: "none" })
  union Mutation {
    circle: Shapes.Circle,
    square: Shapes.Square,
  }

  @discriminator("kind")
  model Float {
    kind: string;
  }

  model Sinking extends Float {
    kind: "sinking";
    depth: int32;
  }

  model Users {
    query: Query;
    string: String;
    duration: Duration;
    subscription: Subscription;
    id: ID;
    mutation: Mutation;
    float: Float;
  }
}

model Page<Item> {
  items: Item[];
  total: int32;
}

// Templates with several arguments, a union or scalar template as an argument, and arguments with
// no name: a value and a literal.
model Duo<First, Second> {
  first: First;
  second: Second;
}

union Choice<A, B> {
  a: A,
  b: B,
}

scalar Code<Format> extends string;

model Tagged<Item, Label extends valueof string> {
  item: Item;
}

model Marked<Mark> {
  note: string;
}

// An interface and an operation instance as arguments: upstream composes any template instance.
interface Ops<T> {
  get(): T;
}

op Fetch<T>(): T;

model Paged {
  gadgets: Page<Gadget>;
  lists: Page<Gadget[]>;
  pages: Page<Page<Gadget>>;
  duo: Duo<string, Gadget>;
  choices: Page<Choice<Gadget, Tree>>;
  codes: Page<Code<string>>;
  tagged: Tagged<Gadget, "y">;
  marked: Marked<"a">;
  ops: Marked<Ops<Gadget>>;
  fetches: Marked<Fetch<Gadget>>;
  unnamed: Page<string | int32>;
}

model Tree {
  label: string;
  children: Tree[];
}

model Pair {
  created_at: string;
  createdAt: string;
}

// GraphQL forbids an object or input type with no field, so a model that carries no payload
// property under the position's visibility cannot be a type of its own.
model Empty {}

// A property typed as one member of an enum, or one variant of a union, the usual way to write a
// discriminator: its GraphQL type is the enum, or the variant's own type.
union Mood {
  calm: "calm",
  busy: "busy",
}

model Kennel {
  status: Status.Done;
  mood: Mood.calm;
}

model OnlyMetadata {
  @header etag: string;
}

model Holder {
  empty: Empty;
  metadata: OnlyMetadata;
  label: string;
}

/** A union whose variant holds the union: reached through the variant first, it is still a union. */
@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Figure {
  cluster: Cluster,
  dab: Dab,
}

model Cluster {
  kind: "cluster";
  children: Figure[];
}

model Dab {
  kind: "dab";
}

/** The same through `@discriminator`: a derived model that holds its base. */
@discriminator("kind")
model Fauna {
  kind: string;
}

model Flock extends Fauna {
  kind: "flock";
  members: Fauna[];
}

model Mole extends Fauna {
  kind: "mole";
}

/**
 * A variant that holds its union, before one that projects to no object type: the union is `JSON`,
 * and the variant's field that holds it must say so too.
 */
@discriminated(#{ envelope: "none" })
union Knot {
  loop: Loop,
  open: OpenVariant,
}

model Loop {
  kind: "loop";
  next: Knot[];
}

/** The same through `@discriminator`. */
@discriminator("kind")
model Tangle {
  kind: string;
}

model Coil extends Tangle {
  kind: "coil";
  next: Tangle[];
}

model Frayed extends Tangle {
  kind: "frayed";
  ...Record<string>;
}

/**
 * Anonymous types named first after a member whose name GraphQL already owns (`BigInteger`,
 * `BigDecimal`), then reached again under another name: each is one type, so it stays `JSON`.
 */
alias Point = {
  x: int32;
};

alias Axis = "x" | "y";

model Big {
  @visibility(Lifecycle.Read) id: string;
  integer: Point;
  again: Point;
  decimal: Axis;
}

/** The union of literals `Big.decimal` reached first, under a name of its own here. */
model Plot {
  axis: Axis;
}

// A base whose anonymous member each subtype inherits, and a model spreading it: one member,
// `Habitat.climate`, whichever model holding it is projected first.
model Habitat {
  climate: {
    rain: int32;
  };
}

model Desert extends Habitat {
  sand: boolean;
}

model Tundra extends Habitat {
  ice: boolean;
}

model Oasis {
  ...Habitat;
  water: boolean;
}

// Instances of one template, its argument a literal its composed name leaves out: each `is` model
// declares its own member.
model Crate<T> {
  contents: {
    item: T;
  };
}

model Box is Crate<"box">;

model Bin is Crate<"bin">;

// One template instance, its argument named, reached by `extends` from two models and copied by an
// `is`: its member is the instance's, `ShelfOfString`.
model Shelf<T> {
  label: {
    text: T;
  };
}

model Top extends Shelf<string> {
  top: int32;
}

model Bottom extends Shelf<string> {
  bottom: int32;
}

model Rack is Shelf<string>;

// A visibility transform's copy: `face`, reshaped at Create, is a type of `DialCreate`'s own, while
// `rim`, untouched, stays `Dial.rim`. `glass`, spread from `Bezel` and reshaped, keeps its source
// `Bezel.glass`, of the type before the transform.
model Bezel {
  glass: {
    @visibility(Lifecycle.Read) scratched: boolean;
    clear: boolean;
  };
}

model Dial {
  @visibility(Lifecycle.Read) id: string;
  ...Bezel;
  face: {
    @visibility(Lifecycle.Read) at: string;
    hand: int32;
  };
  rim: {
    size: int32;
  };
}

model DialCreate is Create<Dial>;

// Instances whose composed names leave out an argument: a literal beside a named one, and a union.
model Twin<A, B> {
  tag: {
    a: A;
    b: B;
  };
}

model TwinOne is Twin<string, "one">;

model TwinTwo is Twin<string, "two">;

model Mix is Crate<"a" | "b">;

model Mox is Crate<"c" | "d">;

// A discriminated base that is an instance whose name leaves out its argument: its own members,
// the discriminator among them, are named after the base, `Pen`, its subtype replacing `tip`.
@discriminator("kind")
model Pen<T> {
  kind: "quill" | "brush";
  tip: {
    size: int32;
  };
  mark: T;
}

model Quill extends Pen<"ink"> {
  kind: "quill";
  tip: {
    size: int32;
    nib: string;
  };
}

// A union of literals members reach through one alias: one enum, named after the first declared,
// a namespace's own models before its children's, though `Tinted` comes first in the file.
alias Tone = "warm" | "cool";

// A template declaration holding the alias's type, before every holder: no model is declared by it.
model Swatch<T> {
  tone: Tone;
  tag: T;
}

namespace Tinted {
  model Shade {
    tone: Tone;
  }
}

model Lamp {
  tone: Tone;
}

model Paint {
  tone: Tone;
}

// One template instance whose composed name leaves out its argument, reached by `extends` from two
// models: its member is one type, named after the first model declared.
model Low extends Crate<"x"> {
  low: int32;
}

model High extends Crate<"x"> {
  high: int32;
}

// A list of an anonymous model two members reach through one alias: its items are one type.
alias Rows = {
  cell: string;
}[];

model Sheet {
  rows: Rows;
}

model Ledger {
  rows: Rows;
}

// A declared model GraphQL cannot state, held by two members: its warning names the member that
// reached it, as it names a declared type's.
model Spill {
  ...Record<string>;
  level: int32;
}

// A tuple, which GraphQL cannot state either, two members hold through one alias.
alias Couple = [string, int32];

model Bucket {
  spill: Spill;
  couple: Couple;
}

model Drain {
  spill: Spill;
  either: Either;
  couple: Couple;
}

// A named model and a named union of literals, each reached through a `| null` alias two members
// hold: each is named by itself, and nothing is shared.
alias MaybeGadget = Gadget | null;

alias MaybeMood = Mood | null;

model Kiln {
  gadget: MaybeGadget;
  mood: MaybeMood;
}

model Forge {
  gadget: MaybeGadget;
  mood: MaybeMood;
}

// An anonymous member spreading an instance no declared model's member holds the type of, beside a
// property of its own: the member it copies is the instance's, `ShelfOfInt32Label`.
model Cabinet {
  box: {
    ...Shelf<int32>;
    drawer: int32;
  };
}

// A model the request reshapes at Update and not at Create: `reading` is one input at both, and
// `limits`, reshaped at Update itself, one at each.
model Gauge {
  @visibility(Lifecycle.Read, Lifecycle.Create) serial: string;
  reading: {
    value: int32;
  };
  limits: {
    @visibility(Lifecycle.Read, Lifecycle.Create) floor: int32;
    ceiling: int32;
  };
}

// A base whose own field its subtype narrows, whose anonymous model its subtype replaces, and that
// refers back to itself.
@discriminator("kind")
model Note {
  kind: string;
  body: string | null;
  meta: {
    words: int32;
  };
  reply?: Note;
}

model Memo extends Note {
  kind: "memo";
  body: string;
  meta: {
    words: int32;
    chars: int32;
  };
  title: string | null;
}

// A base that carries additional properties.
@discriminator("kind")
model Sprawl {
  kind: string;
  ...Record<string>;
}

model Sprig extends Sprawl {
  kind: "sprig";
}

// A base whose own declaration of the discriminator is sent as another key: openapi3 publishes
// `Animal` with `type` and the `kind` it adds, and `Bird` with both.
@discriminator("kind")
model Animal {
  @encodedName("application/json", "type") kind: string;
  legs: int32;
}

model Bird extends Animal {
  kind: "bird";
  wings: int32;
}

op read(): Widget;
