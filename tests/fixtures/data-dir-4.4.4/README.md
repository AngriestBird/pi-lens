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

`dispatch-mark/cache/diagnostic-dispositions.json` is a second store from the
same 4.4.4 build, written by `markDisposition(alias, …, "false-positive",
"4.4.4 fixture")` for `aliasproj/src/x.ts` (tool `eslint`, rule `no-bad`,
message `bad call`, line 1, content `export const target = bad();`). Its strict
anchor is `dd:164197458e2b`; the build gave the same anchor under two
different parent directories, so the anchor depends on no absolute path.

#4689 review r2 A located the disposition store by the root's path identity,
because dispatch holds that form and the mark tool holds the spelling. This
store sits where 4.4.4 put it, in the data dir of the spelling.
`tests/clients/dispatch/disposition-monorepo-base.test.ts` proves that it is
still honored. It is adopted at `session_start`, or on any read that holds the
spelling, and then a dispatch that holds only the identity reads it.
