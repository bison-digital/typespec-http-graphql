import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

// A field deprecated while it is still required: the first step of a migration. GraphQL refuses
// `@deprecated` on a non-null input field, so the reason has to travel in its description.
@service(#{ title: "Deprecations" })
namespace Deprecations;

model Gizmo {
  #deprecated "use label"
  name: string;

  #deprecated "dropped next release"
  nickname?: string;

  label?: string;
}

@route("/gizmos")
interface Gizmos {
  @post create(
    #deprecated "send X-Gizmo-Version instead"
    @header("X-Legacy") legacy: string,

    @body body: Gizmo,
  ): Gizmo;

  @get @route("/{id}") read(@path id: string): Gizmo;
}

@@queryField(Gizmos.read, "gizmo");
@@mutationField(Gizmos.create, "createGizmo");
