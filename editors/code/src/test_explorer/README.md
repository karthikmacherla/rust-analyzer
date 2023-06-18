## How it works

### Glossary
Runnable: Rust Analyzer has an internal structure called "Runnable", which is used to debug/run, which you might already be familar with.
TestItem: This is the structure used by vscode, and it's the surface of VSCode and RA.
TestModelNodes: This is a very easy AST, help to store meta info of tests and structure.

### Basic
Bascially, we maintain TestModel tree and build test items based on TestModel tree and runnables.



## Issues
There are many strategies about when to send what requests.

Like the laziness is a big choice. When would you like to load how many tests?

An obvious choice to to load all tests for all projects at the first time, then update the changed files.(this is what's used now)

Another choice is only to load test cases laziness. Only when we open a file or click expand button of the case in test explorer, we load itself and its parents(if they are not loaded yet).

1. Where should user go when they click "open file" for test module, definition or the declaration?

For now, I choose declaration
``` rs
//// mod.rs
mod foo;  // <-- user will be redirect to here

//// foo.rs
// some code(first line) // rather than here
// some code
```

Because most people know F12(goto implementation), and less people know "locate parent module" command.

2. How to know whether a test case start? When run the whole test suite, how to know the test case in it is queued or started?

Because the the output is only text(some other framework might provide a server), we could only analytics the output. However, this is unstable and buggy in nature. And we could not always get what we want. In the worst case, we could only guess.

For example
```
--- Workspace
|  //omit cargo file
|-package1
|    |  // omit cargo file
|    |-tests
|        |-foo-bar.rs
|    
|
|-package2
|    |  // omit cargo file
|    |-tests
|        |-foo-bar.rs
```
This is valid, however, the output will be somthing like
```
     Running tests/foo-bar.rs (target/debug/deps/foo_bar-b2e07b357bb81962)

running 1 test
test foo1 ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/foo-bar.rs (target/debug/deps/foo_bar-ce4c61ef5dd225ce)

running 1 test
test foo2 ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```
We could not distinguilish which target is executed exactly. The best thing we could do is to guess by the test path(in this example, they are "foo1" and "foo2")

But the guess logic is not implemented yet :P. Instead, we not allow to run test on workspace level.

3. For cargo, there is no way to match test mod exactly, let's say you have tests

mod1::mod2::mod3::test1

mod2::mod3::test2

mod2::mod3::test3

Then, you want to test all cases under mod2::mod3, but sadly, test1 will be matched too. This will rarely happens in a real repo, but it should be a flaw.

And you could even declare such situation

mod1::foo(this is a test module)

mod1::foo(this is a test case)

When you want to run `mod1::foo`(module), the cause will be matched too.

- Maybe we could add "::" at the end if it's a test module

4. Altough in the design, the `path` attribute is considered, it will make things much more complex, let skip it for the first PR.

5. How to make sure ra is update before the request?

6. The error message shown on the test rather than the line.
    - enahnce the analyzre

7. User could only choose one test case to run
    - Maybe filter could help
    - But it seems we could never run differnt target

8. As mentioned in 2 point, "run all" does not work for workspace level for now.

9. Debug will not update the state of test item.(could provide better experience for Linux)
