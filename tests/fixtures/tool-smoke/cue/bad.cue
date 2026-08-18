// Tool-smoke fixture for the CUE LSP — an unclosed struct.
//
// It must be a SYNTAX error, not an evaluation error: cuelsp reports load and
// parse errors as you type, and leaves conflicting values and failed
// constraints to `cue vet`. The earlier `a: int = "hello"` fixture was an
// evaluation error, so the server correctly published nothing and the smoke
// could only pass vacuously.
package smoke

a: {
