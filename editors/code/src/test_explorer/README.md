### Trade-off
There are many strategies about when to send what requests.

Like the laziness is a big choice. When would you like to load how many tests?

An obvious choice to to load all tests for all projects at the first time, then update the changed files.(this is what's used now)

Another choice is only to load test cases laziness. Only when we open a file or click expand button of the case in test explorer, we load itself and its parents(if they are not loaded yet).

1. Where should user go when they click "open file" for test module, definition or the declaration?
For now, I choose declaration

1. How to know whether a test case start? When run the whole test suite, how to know the test case in it is queued or started?
1. How to support multi select test cases, especially when the target is differnt(part of them might be --lib, and part of them might be --test)?
1. For run and debug, should we use the same command or not?
Cargo seems not to provide such feature to know the exactly state of a test, we could only know one test is finished from the output.
If we want to know it's finished, we could only run them one by one(maybe parallel is possible? with --no-run firstly, then run them parallely). But cargo could run them in parallel.
So bascially, there is two choices,
- Only one cargo command,
  - Positive:
    - Friendly to debug, because for debug situation we could not run many commands
    - Less surprise, this is how people run the tests in most of time.
  - Negative:
    - We could only analyitcs the stdoutput, which is obviously buggy. And need to remove --nocapture, to make it more easy to parse.
    - Not know the state of a test. Either it's queued, or finished, there is no started.
    - And it's not possible to run different target(--lib and --test).
- each command for each cases
  - Positive:
    - Know when it's runned, becuase we control it now!
    - Could run different target
    - Easy to parse the result
  - Negative:
    - More complex logic to run ignored test, if run a test mod, it's skiped, if run itself, it's runned.
    - What about debug? Could we start debug sessions one by one? seems not acceptable.
    - Might be strange, because finally user would like to run them in CLI, which might differnt with how we run the tests(we could only run them serially, but by defualt it's run parallelly)
I decide that user could only run one test, as if they click the code lens of the runnable. Show an error otherwise.

### Problems
1. For cargo, there is no way to match test mod exactly, let's say you have tests
mod1::mod2::mod3::test1
mod2::mod3::test2
mod2::mod3::test3
Then, you want to test all cases under mod2::mod3, but sadly, test1 will be matched too. This will rarely happens in a real repo, but it should be a flaw.
And you could even declare such situation
mod1::foo(this is a test module)
mod1::foo(this is a test case)
When you want to run mod1::foo(module), the cause will be matched too.

1. Altough in the design, the `path` attribute is considered, it will make things much more complex, let skip it for the first PR.

1. How to make sure ra is update before the request?

### Known issue
1. The error message shown on the test rather than the line.
    - enahnce the analyzre

1. User could only choose one test case to run
    - Maybe filter could help
    - But it seems we could never run differnt target

1. Not support debug/run all.(could provide better experience when there is only one workspace, but might be confusing, because sometimes it works, sometimes not)

1. Debug will not update the state of test item.(could provide better experience for Linux, but what about windows?)

1. For the first time, it's slow to load. We could show something to tell user just like playwright test extension

1. Does not support vscode workspace? I never use it, when will people use it?
