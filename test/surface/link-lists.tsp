import "typespec-http-graphql";
import "./rest.tsp";

using Http;
using HttpGraphQL;
using Surface;

namespace Surface {
  /** An author id the read checks more strictly than the models that hold one declare it. */
  @pattern("^t-[0-9]+$")
  scalar AuthorId extends string;

  model Roster {
    @key id: string;
    @maxItems(20) authorIds: string[];
    @maxItems(5) moreIds: string[];
    @maxItems(5) maybeIds: string[] | null;
    unboundedIds: string[];
    @maxItems(5) counts: int32[];
  }

  model AuthorPage {
    @pageItems items: Author[];
    @continuationToken next?: string;
  }

  @route("/rosters")
  interface Rosters {
    @get read(@path id: string): Roster | NotFound;
  }

  @route("/checked-authors")
  interface CheckedAuthors {
    @get read(@path authorId: AuthorId): Author | NotFound;
    @route("/pair") @get pair(@query a: string, @query b: string): Author | NotFound;
    @route("/pages") @list @get pages(
      @query owner: string,
      @query @pageSize limit?: int32,
      @query @continuationToken cursor?: string,
    ): AuthorPage;
  }
}

@@queryField(Rosters.read, "roster");

// A list of values the parameter accepts: one call per value.
@@link(Roster, "authors", Authors.read, #{ authorId: "authorIds" });
// A nullable list binds as a list: its `null` answers the field `null`.
@@link(Roster, "maybeAuthors", Authors.read, #{ authorId: "maybeIds" });
// `string` fills an `AuthorId extends string` parameter, which narrows it, alone and as a list's
// items.
@@link(Widget, "checkedAuthor", CheckedAuthors.read, #{ authorId: "display_name" });
@@link(Roster, "checkedAuthors", CheckedAuthors.read, #{ authorId: "authorIds" });

// No @maxItems: nothing bounds the calls.
@@link(Roster, "unbounded", Authors.read, #{ authorId: "unboundedIds" });
// A list of `int32` cannot fill `authorId: string`.
@@link(Roster, "byCounts", Authors.read, #{ authorId: "counts" });
// Two lists: the product of two lists is no field.
@@link(Roster, "pairs", CheckedAuthors.pair, #{ a: "authorIds", b: "moreIds" });
// A list of pages is no field either.
@@link(Roster, "authorPages", CheckedAuthors.pages, #{ owner: "authorIds" });
