import "@typespec/http";

using Http;

/**
 * A bookshop's paging shapes, with the five core paging decorators, and one operation per way of
 * falling short of a connection.
 */
@service(#{ title: "Paging" })
namespace Paging;

model Book {
  id: string;
  title: string;
}

model Edition {
  id: string;
}

/** A page size bounded by its scalar, below a base that bounds it less, below `int32`. */
@maxValue(40)
scalar SmallPage extends WidePage;
@maxValue(80)
scalar WidePage extends int32;

/** A page of items, as a backend answers one. */
model Page<Item> {
  @pageItems items: Item[];
  @continuationToken @encodedName("application/json", "nextCursor") next_cursor?: string;
}

/** The paging half of a list request. */
model PageRequest {
  /** How many items to return. */
  @query @pageSize @maxValue(200) limit?: int32 = 50;

  /** Where the previous page ended. */
  @query @continuationToken cursor?: string;
}

model NoNext {
  @pageItems items: Book[];
  next_cursor?: string;
}

model Nested {
  data: {
    @pageItems items: Book[];
  };
  @continuationToken next_cursor?: string;
}

model Linked {
  @pageItems items: Book[];
  @nextLink next?: url;
}

model HeaderNext {
  @pageItems items: Book[];
  @header @continuationToken next?: string;
}

model Navigable {
  @pageItems items: Book[];
  @continuationToken @encodedName("application/json", "nextCursor") next_cursor?: string;
  @prevLink prev?: url;
  @firstLink first?: url;
  @lastLink last?: url;
}

model SearchBody {
  @continuationToken cursor?: string;
}

/** A cell of a grid, named by the variant it takes: a row of books, or one. */
union Cell {
  row: Book[],
  one: Book,
}

@route("/books")
interface Books {
  @get read(@path id: string): Book;
  @list @get list(...PageRequest, @query authorId?: string): Page<Book>;
  @list @get @route("/wrapped") wrapped(...PageRequest): {
    @statusCode _: 200;
    @body body: Page<Book>;
  };
  @list @get @route("/no-next") noNext(...PageRequest): NoNext;
  @list @get @route("/header-next") headerNext(...PageRequest): HeaderNext;
  @list @get @route("/no-token") noToken(@query @pageSize limit?: int32): Page<Book>;
  @list @post @route("/search") search(@query @pageSize limit?: int32, @body body: SearchBody): Page<Book>;
  @list @get @route("/no-size") noSize(@query @continuationToken cursor?: string): Page<Book>;
  @list @get @route("/nested") nested(...PageRequest): Nested;
  @list @get @route("/grid") grid(...PageRequest): Page<Book[]>;
  @list @get @route("/sparse-grid") sparseGrid(...PageRequest): Page<Book[] | null>;
  @list @get @route("/rows") rows(...PageRequest): Page<Cell.row>;
  @list @get @route("/sparse") sparse(...PageRequest): Page<Book | null>;
  @list @get @route("/tags") tags(...PageRequest): Page<string>;
  @list @get @route("/mixed") mixed(...PageRequest): Page<Book[] | string>;
  @list @get @route("/offset") offset(@query @offset skip?: int32, @query @pageSize limit?: int32): Page<Book>;
  @list @get @route("/indexed") indexed(@query @pageIndex page?: int32, @query @pageSize limit?: int32): Page<Book>;
  @list @get @route("/linked") linked(...PageRequest): Linked;
  @list @get @route("/navigable") navigable(...PageRequest): Navigable;
  @list @get @route("/bounded") bounded(
    @query @pageSize @maxValue(100) limit?: int32,
    @query @continuationToken cursor?: string,
  ): Page<Book>;
  @list @get @route("/exclusive") exclusive(
    @query @pageSize @maxValueExclusive(30) limit?: int32 = 10,
    @query @continuationToken cursor?: string,
  ): Page<Book>;
  @list @get @route("/scalar-bounded") scalarBounded(
    @query @pageSize limit?: SmallPage,
    @query @continuationToken cursor?: string,
  ): Page<Book>;
  @list @get @route("/fractional") fractional(
    @query @pageSize @maxValue(10.5) limit?: float64,
    @query @continuationToken cursor?: string,
  ): Page<Book>;
}

@route("/books/{bookId}/editions")
interface BookEditions {
  @list @get list(@path bookId: string, ...PageRequest): Page<Edition>;
}

/** A model of the spec's own that takes the name the connection types need. */
model PageInfo {
  total: int32;
}
