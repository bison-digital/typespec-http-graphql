import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/** Properties that are lists, and some that are not, each bounded or not. */
@service
namespace Bookshop;

@maxItems(4)
model Codes is string[];

model Shelf {
  /** A list, bounded on the property. */
  @maxItems(2) tags: string[];

  /** A nullable list, bounded on the property. */
  @maxItems(5) maybe: string[] | null;

  /** A list bounded by its array type. */
  codes: Codes;

  /** A list unbounded. */
  pairs: string[];

  /** A list or a number: no list. */
  either: string[] | int32;

  /** A scalar: no list. */
  title: string;

  /** No list, though it carries a bound. */
  @maxLength(3) flag: string;
}

@route("/shelves")
interface Shelves {
  @get read(): Shelf;
}
