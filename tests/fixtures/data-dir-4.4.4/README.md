# A project data directory as pi-lens 4.4.4 wrote it

`cache/diagnostic-dispositions.json` is the disposition store pi-lens 4.4.4
(origin/master `755c1c7a3`) wrote for a project whose session root is spelled
through a directory link (`aliasproj -> realproj`). It was written by
`markDisposition(alias, …, "suppress", "probe")` from the 4.4.4 build, then
copied verbatim. It holds no absolute path: a weak anchor (`ddw:`) encodes only
a project-relative path plus tool, rule and message.

What 4.4.4 decided is the directory's NAME, not its content. Its readable half
and its hash half both came from the root's spelling (`path.resolve(cwd)`).
#4689 r1 moved the readable half to the path identity, so an upgrade read a
different directory and lost every mark (review r1 F2). The maintainer decided
on 2026-10-21 to keep the 4.4.4 name with no migration.

`tests/clients/project-data-dir-slug.test.ts` places this store where 4.4.4
put it, under the name the pinned slug contract gives the alias spelling. It
then reads the mark back through the real reader.
