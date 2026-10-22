// Two services, each with its own GraphQL surface. Each service's surface holds only its own.
import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

@service(#{ title: "Alpha" })
namespace Alpha {
  model Thing {
    @key id: string;
  }

  @route("/things/{id}") @get op read(@path id: string): Thing;
  @route("/things") @get op list(): Thing[];
}

@service(#{ title: "Beta" })
namespace Beta {
  model Item {
    @key id: string;
    thingId: string;
  }

  @route("/items/{id}") @get op read(@path id: string): Item;
}

@@queryField(Alpha.read, "thing");
@@queryField(Alpha.list, "things");
@@queryField(Beta.read, "item");
@@link(Beta.Item, "self", Beta.read, #{ id: "id" });

// A link belongs to the service whose operation it calls: this one is Alpha's.
@@link(Beta.Item, "thing", Alpha.read, #{ id: "thingId" });
