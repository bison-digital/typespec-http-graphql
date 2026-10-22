import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * Two services projecting one shared model, which holds a union GraphQL cannot state: each warning
 * is about one declaration, and is raised once however many services meet it.
 */
namespace Shared {
  union Anything {
    text: string,
    count: float64,
  }

  model Category {
    id: string;
    extra: Anything;
  }

  @error
  model NotFound {
    @statusCode _: 404;
    message: string;
  }
}

@service
namespace North {
  @route("/categories")
  interface Categories {
    @get read(@path id: string): Shared.Category | Shared.NotFound;
  }
}

@service
namespace South {
  @route("/categories")
  interface Categories {
    @get read(@path id: string): Shared.Category | Shared.NotFound;
  }
}

@@queryField(North.Categories.read, "category");
@@queryField(South.Categories.read, "category");
// A type both services state as an object of their own: there is no JSON to accept.
@@json(Shared.Category);
