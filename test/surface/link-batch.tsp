import "typespec-http-graphql";
import "./rest.tsp";

using Http;
using HttpGraphQL;
using Surface;

namespace Surface {
  model Shelf {
    @key id: string;
    authorId: string | null;
    @maxItems(10) authorIds: string[];
    count: int32;
    @maxItems(3) languages: string[];
  }

  model Penned {
    @key id: string;
    nickname?: string;
    count: int32;
  }

  @route("/shelves")
  interface Shelves {
    @get read(@path id: string): Shelf | NotFound;
  }

  /** Batch reads of authors, each answering the authors whose ids it was sent. */
  @route("/batch-authors")
  interface BatchAuthors {
    @get batchGet(@query(#{ explode: true }) @maxItems(50) ids: string[]): { authors: Author[] } | NotFound;
    @route("/bare") @get bare(@query(#{ explode: true }) ids: string[]): Author[];
    @route("/by-path") @get byPath(@path ids: string[]): Author[];
    @route("/at-least") @get atLeast(@query(#{ explode: true }) @minItems(2) ids: string[]): Author[];
    @route("/pages") @list @get pages(
      @query(#{ explode: true }) ids: string[],
      @query @pageSize limit?: int32,
      @query @continuationToken cursor?: string,
    ): {
      @pageItems items: Author[];
      @continuationToken next?: string;
    };
    @route("/twice") @get twice(@query(#{ explode: true }) ids: string[]): {
      authors: Author[];
      editors: Author[];
    };
    @route("/strings") @get strings(@query(#{ explode: true }) ids: string[]): string[];
    @route("/in-language") @get inLanguage(@query(#{ explode: true }) ids: string[], @query lang: string): Author[];
    @route("/penned") @get penned(@query(#{ explode: true }) ids: string[]): Penned[];
    @route("/answers") @get answers(@query(#{ explode: true }) ids: string[]): {
      @statusCode _: 200;
      @body body: Author[];
    } | {
      @statusCode _: 203;
      @body body: Penned[];
    };
  }
}

@@queryField(Shelves.read, "shelf");

// A batch of one value per shelf, the list under `authors`; and of a bare list, from a shelf's list.
@@link(Shelf, "author", BatchAuthors.batchGet, #{ ids: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "authors", BatchAuthors.bare, #{ ids: "authorIds" }, #{ batch: #{ key: "id" } });
// `items` names the list where the body holds two.
@@link(Shelf, "named", BatchAuthors.twice, #{ ids: "authorId" }, #{ batch: #{ key: "id", items: "editors" } });

// link-batch-invalid, one reason each.
@@link(Shelf, "noList", Authors.read, #{ authorId: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "inPath", BatchAuthors.byPath, #{ ids: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "atLeastTwo", BatchAuthors.atLeast, #{ ids: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "paged", BatchAuthors.pages, #{ ids: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "ambiguous", BatchAuthors.twice, #{ ids: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "misnamed", BatchAuthors.twice, #{ ids: "authorId" }, #{ batch: #{ key: "id", items: "readers" } });
@@link(Shelf, "ofStrings", BatchAuthors.strings, #{ ids: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "unkeyed", BatchAuthors.bare, #{ ids: "authorId" }, #{ batch: #{ key: "uid" } });
@@link(Shelf, "optionalKey", BatchAuthors.penned, #{ ids: "authorId" }, #{ batch: #{ key: "nickname" } });
@@link(Shelf, "wrongKey", BatchAuthors.penned, #{ ids: "authorId" }, #{ batch: #{ key: "count" } });
@@link(Shelf, "twoAnswers", BatchAuthors.answers, #{ ids: "authorId" }, #{ batch: #{ key: "id" } });
@@link(Shelf, "translated", BatchAuthors.inLanguage, #{ lang: "languages", ids: "authorId" }, #{ batch: #{ key: "id" } });

// A value the batch parameter's items do not accept is a type mismatch, batch or not.
@@link(Shelf, "byCount", BatchAuthors.bare, #{ ids: "count" }, #{ batch: #{ key: "id" } });
