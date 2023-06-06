/* eslint-disable no-console */
import * as vscode from "vscode";
import { assert, assertNever } from "../util";
import { getTestItemByTestLikeNode, getTestModelByTestItem } from "./discover_and_update";
import { NodeKind, Nodes, getWorkspaceNodeOfTestModelNode, testModelTree } from "./test_model_tree";
import { sep } from 'node:path';

const targetPatternNamedCaptureGroup = {
    /**
     * like 'src/lib.rs', seprator is os-sensitive
     */
    relativePath: 'relativePath',
    /**
     * normarlized target name, '-' is relaced by '_'
     *
     * please refer https://www.reddit.com/r/rust/comments/8sezkm/where_are_the_rules_for_creating_valid_rust
     */
    normalizedTargetName: 'normalizedTargetName',
} as const;

// when target is lib/bin, there is "unittests ", when target is integration test, there is not
const sepInRegexString = sep === '\\' ? '\\\\' : sep;
const targetPattern = new RegExp(`Running (?:unittests )?(?<${targetPatternNamedCaptureGroup.relativePath}>.*?) \(.*${sepInRegexString}(?<${targetPatternNamedCaptureGroup.normalizedTargetName}>.*?)-.*?\)`);

const caseResultPattern = /^test (.*?) ... (\w*)$/;
const stacktraceTestCasePattern = /^---- (.*?) stdout ----$/;
const stacktraceStartPattern = /^failures:$/;
// Although it is the same as start pattern in the output of rustc now,
// we means the end of the stack trace part.
const stacktraceEndPattern = /^failures:$/;

abstract class RustcOutputAnalyzer {
    private _testItemLocator: TestItemLocator;
    protected _testRun: vscode.TestRun;
    constructor(
         testRun: vscode.TestRun,
        testItem: vscode.TestItem,
    ) {
        this._testRun = testRun;
        this._testItemLocator = new TestItemLocator(testItem);
    }

    private _currentNormalizedTargetName: string | undefined = undefined;
    private _currentTargetRelativePath: string | undefined = undefined;

    protected analyticsCurrentTestTarget(line: string) {
        const match = targetPattern.exec(line); // Running unittests src\\lib.rs (target\\debug\\deps\\hashbrown-3547e1bc587fc63a.exe)
        if (match) {
            this._currentNormalizedTargetName = match?.groups?.[targetPatternNamedCaptureGroup.normalizedTargetName];
            this._currentTargetRelativePath = match?.groups?.[targetPatternNamedCaptureGroup.relativePath];
        }
    }

    protected analyticsTestCaseResult(line: string) {
        const match = caseResultPattern.exec(line);
        const rustcCasePath = match?.[1];
        const rustcTestResultString = match?.[2];
        if (rustcCasePath && rustcTestResultString) {
            const rustcTestResult = RustcTestResult.parse(rustcTestResultString);
            const testItem = this._testItemLocator.findTestItemByRustcOutputCasePath(
                this._currentNormalizedTargetName!,
                this._currentTargetRelativePath!,
                rustcCasePath);
            if (!testItem) { return; }
            // TODO: time is only supported in nightly, but we could add them
            switch (rustcTestResult) {
                case RustcTestResult.passed:
                    this._testRun.passed(testItem);
                    break;
                case RustcTestResult.failed:
                    // Mark test item failed
                    // The error message is added later, in `analyticsStackTrace`
                    this._testRun.failed(testItem, []);
                    break;
                case RustcTestResult.ignored:
                    this._testRun.skipped(testItem);
                    break;
                default:
                    assertNever(rustcTestResult);
            }
        }
    }


    // At the end of the output, when the tests are all finished
    // stack trace(if any failed) will be output together in a big `data`
    // set this flag to analytics all the output
    private _failureContextAnalyticsFlag = false;
    private _currentFailedRustcOutputTest: vscode.TestItem | undefined = undefined;
    private _currentFailedCaseOutputWithStackTrace: string[] = [];

    protected analyticsStackTrace(line: string) {
        if (!this._failureContextAnalyticsFlag && stacktraceStartPattern.test(line)) {
            this._failureContextAnalyticsFlag = true;
            return;
        }
        if (this._failureContextAnalyticsFlag && stacktraceEndPattern.test(line)) {
            this._failureContextAnalyticsFlag = false;
            this.flushStackTraceAnalytics();
            return;
        }
        if (this._failureContextAnalyticsFlag) {
            const match = stacktraceTestCasePattern.exec(line);
            const rustcCasePath = match?.[1];
            if (rustcCasePath) {
                const testItem = this._testItemLocator.findTestItemByRustcOutputCasePath(
                    this._currentNormalizedTargetName!,
                    this._currentTargetRelativePath!,
                    rustcCasePath);
                if (!testItem) { assert(false, "Should never happened. Could not bear this error."); }
                this.flushStackTraceAnalytics();
                this._currentFailedRustcOutputTest = testItem;
            }
            this._currentFailedCaseOutputWithStackTrace.push(line);
        }
    }

    protected flushStackTraceAnalytics() {
        if (this._currentFailedRustcOutputTest) {
            this._testRun.failed(this._currentFailedRustcOutputTest, new vscode.TestMessage(this._currentFailedCaseOutputWithStackTrace.join('\n')));
        }
        this._currentFailedCaseOutputWithStackTrace = [];
    }
}

// why replace: refer https://code.visualstudio.com/api/extension-guides/testing#test-output
function normalizeOutputData(data: any): string {
    return data.toString().replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

enum RustcTestResult {
    passed,
    failed,
    ignored,
}

namespace RustcTestResult {
    export function parse(rustcResultString: string) {
        switch (rustcResultString) {
            case 'ok':
                return RustcTestResult.passed;
            case 'ignored':
                return RustcTestResult.ignored;
            case 'FAILED':
                return RustcTestResult.failed;
            default:
                console.log(`Could not handle result of rustc "${rustcResultString}"`);
                assert(false, "What should we do if this is changed? Throw error?");
        }
    }
}

class TestItemLocator {
    private readonly _testModel: Nodes;

    // We only allow one test case to be runned
    constructor(chosenRunnedTestItem: vscode.TestItem) {
        this._testModel = getTestModelByTestItem(chosenRunnedTestItem);
        assert(this._testModel.kind === NodeKind.Test
            || this._testModel.kind === NodeKind.TestModule
            || this._testModel.kind === NodeKind.Target
            || this._testModel.kind === NodeKind.CargoPackage,
            "does not support workspace level, until we allow try to guess the target"
        );
    }

    /**
     * @param path This is the path which is shown on the output of test result, like mod1::mod2::mod3::test1
     */
    findTestItemByRustcOutputCasePath(packageNormalizedName: string, targetRelativePath: string, path: string): vscode.TestItem | undefined {
        // get workspace through runned test item
        // get package through packageNormalizedName
        // get target through targetRelativePath
        // get test item through path

        const workspaceRootNode = getWorkspaceNodeOfTestModelNode(this._testModel);

        const targetCandidates = workspaceRootNode.members
            .flatMap(packageNode => Array.from(packageNode.targets))
            .filter(target =>
                normalizeTargetName(target.name) === packageNormalizedName
                && target.srcPath.fsPath.includes(targetRelativePath)
            );

        assert(targetCandidates.length === 1, "should find one and only one target node");
        // REVIEW: What should we do if we found 2 or more candidates?

        const targetNode = targetCandidates[0];

        const testNode = testModelTree.findTestLikeNodeUnderTarget(
            targetNode,
            NodeKind.Test,
            path.split('::')
        );

        const candidate = getTestItemByTestLikeNode(testNode);

        return candidate;
    }
}

function normalizeTargetName(packageName: string) {
    return packageName.replace(/-/g, '_');
}

export class LinesRustOutputAnalyzer extends RustcOutputAnalyzer {
    constructor(
        testRun: vscode.TestRun,
        testItem: vscode.TestItem,
    ) {
        super(testRun,testItem);
    }

    public analyticsLines(lines:string[]) {
        lines.forEach(line => {
            this._testRun.appendOutput(line + '\r\n');
            this.analyticsCurrentTestTarget(line);
            this.analyticsTestCaseResult(line);
            this.analyticsStackTrace(line);
        });
     }
}

export class PipeRustcOutputAnalyzer extends RustcOutputAnalyzer {
    constructor(
        testRun: vscode.TestRun,
        testItem: vscode.TestItem,
    ) {
        super(testRun,testItem);
    }

    public onStdErr(data: any) {
        // This is so weird, some messages will be logged as stderr
        // like "Finished test [unoptimized + debuginfo] target(s) in 0.07s"
        // and "Running unittests src\lib.rs (target\debug\deps\hashbrown-3547e1bc587fc63a.exe)"

        // And this make ir hard to use breakpoint to debug, because the buffer will be flushed in unexpected order.
        const normalizedData = normalizeOutputData(data);

        this._testRun.appendOutput(normalizedData);
        console.log(`StdErr:${data}`);

        const lines = normalizedData.split("\r\n");

        lines.forEach(line => {
            this.analyticsCurrentTestTarget(line);
        });
    }

    public onClose() {
        console.log(`Closed`);
        this._testRun.end();
    }

    public onStdOut(data: any) {
        // It seems like the data will be end with a line breaking. Is this promised?
        const normalizedData = normalizeOutputData(data);

        this._testRun.appendOutput(normalizedData);
        console.log(`Stdout:${data}`);

        const lines = normalizedData.split("\r\n");

        lines.forEach(line => {
            this.analyticsTestCaseResult(line);
            this.analyticsStackTrace(line);
        });
    }
}
