import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * What the idiom domain does not show, each in one operation: a `default` error arm, the statuses
 * design.md names codes for (409, 410, 412, 422, 429 with `Retry-After`), a bodyless query, a query
 * with two success bodies, a mutation answering a list, a bodyless refusal, required headers that are
 * arguments, `@encode` on parameters, a date-time header with none, a 64-bit integer, a snake_case wire name, `#deprecated` on an output field, an
 * optional argument, a required argument and a required input field, and a connection whose page size
 * has a maximum and no default.
 */
@service(#{ title: "Extras" })
namespace Extras;

model Item {
  id: string;
  name: string;

  #deprecated "use name"
  label?: string;

  created_at?: utcDateTime;
}

/** The order a list is read in: an argument's enum default. */
enum Order {
  Newest: "newest",
  Oldest: "oldest",
}

model ItemCreate {
  @minLength(1)
  name: string;

  /** Required, and may be null: GraphQL lets a caller leave it out, and then it is null. */
  note: string | null;

  @minLength(3)
  owner_id?: string;

  #deprecated "kinds are inferred"
  kind: string;
}

/** Whatever the operation did not declare exactly: the `| Problem` default arm. */
@error
model Problem {
  message: string;
}

@error
model Clash {
  @statusCode _: 409;
  message: string;
}

@error
model Gone {
  @statusCode _: 410;
  message: string;
}

@error
model Unmet {
  @statusCode _: 412;
  message: string;
}

@error
model Unprocessable {
  @statusCode _: 422;
  message: string;
}

@error
model Busy {
  @statusCode _: 429;
  @header("retry-after") retryAfter?: int32;
  message: string;
}

/** A page of items, with no default size. */
model ItemPage {
  @pageItems items: Item[];
  @continuationToken next?: string;
}

@route("/items")
interface Items {
  @list
  @get
  list(
    @query @pageSize @maxValue(100) size?: int32,
    @query @continuationToken token?: string,
  ): ItemPage;
  @get
  @route("/{id}")
  read(
    @path id: string,
    #deprecated "address an item by its id"
    @query legacy?: string,
  ): Item | Clash | Gone | Busy | Problem;
  @get @route("/{id}/exists") exists(@path id: string): NoContentResponse | Problem;
  @get
  @route("/{id}/either")
  either(
    @path id: string,
    #deprecated "sent for old clients"
    @header("x-api-version") apiVersion: string,
    @query("edition-name") editionName?: string,
  ): { @statusCode _: 200; @body body: Item } | {
    @statusCode _: 202;
    @body body: string[];
  };
  @post create(
    @header("x-store") store: string,
    @body body: ItemCreate,
  ): Item | Unmet | Unprocessable | Problem;
  @post @route("/batch") batch(): Item[];
  @get
  @route("/{id}/history")
  history(
    @path id: string,
    @query @encode(DateTimeKnownEncoding.unixTimestamp, int64) since?: utcDateTime,
    @query after?: int64,
    @header("x-window") @encode(DurationKnownEncoding.seconds, int32) window: duration,
  ): Item[];
  @get @route("/{id}/as-of") asOf(@path id: string, @header("x-as-of") asOf: utcDateTime): Item;
  @delete @route("/{id}") remove(@path id: string): NoContentResponse | NotFoundResponse;
  @get @route("/sorted") sorted(@query order?: Order = Order.Newest): Item[];
}

@@queryField(Items.list, "items");
@@queryField(Items.read, "item");
@@queryField(Items.exists, "itemExists");
@@queryField(Items.either, "itemEither");
@@queryField(Items.history, "itemHistory");
@@queryField(Items.asOf, "itemAsOf");
@@queryField(Items.sorted, "sortedItems");
@@mutationField(Items.create, "createItem");
@@mutationField(Items.batch, "batchItems");
@@mutationField(Items.remove, "removeItem");
