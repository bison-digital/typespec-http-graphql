import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@queryField(Widgets.read, "widget");
@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });

// The library names a scalar or an array `@bodyRoot` after its property, so each is one input
// field: kept.
@@mutationField(Widgets.tally, "tallyWidgets");
@@mutationField(Widgets.batch, "createWidgets");

// A discriminated model as the whole body has no one set of properties to merge: dropped, as a
// root field and as a link.
@@mutationField(Widgets.adopt, "adoptPet");
@@link(Widget, "match", Widgets.match);
