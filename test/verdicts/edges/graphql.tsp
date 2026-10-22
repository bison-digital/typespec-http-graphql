import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Edges;

@@queryField(Entries.read, "entry");
@@queryField(Entries.since, "entriesSince");
@@queryField(Entries.list, "entries");
@@mutationField(Entries.create, "createEntry");
@@queryField(Entries.animal, "animal");
