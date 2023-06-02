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
     * normarlized package name, '-' is relaced by '_'
     *
     * please refer https://www.reddit.com/r/rust/comments/8sezkm/where_are_the_rules_for_creating_valid_rust
     */
    normalizedPackageName: 'normalizedPackageName',
} as const;

// when target is lib/bin, there is "unittests ", when target is integration test, there is not
const sepInRegexString = sep === '\\' ? '\\\\' : sep;
const targetPattern = new RegExp(`Running (?:unittests )?(?<${targetPatternNamedCaptureGroup.relativePath}>.*?) \(.*${sepInRegexString}(?<${targetPatternNamedCaptureGroup.normalizedPackageName}>.*?)-.*?\)`);

const caseResultPattern = /^test (.*?) ... (\w*)$/;
const stacktraceTestCasePattern = /^---- (.*?) stdout ----$/;
const stacktraceStartPattern = /^failures:$/;
// Although it is the same as start pattern in the output of rustc now,
// we means the end of the stack trace part.
const stacktraceEndPattern = /^failures:$/;

export class RustcOutputAnalyzer {
    private _testItemLocator: TestItemLocator;

    constructor(
        private testRun: vscode.TestRun,
        _testItem: vscode.TestItem,
    ) {
        this._testItemLocator = new TestItemLocator(_testItem);
    }

    public onStdErr(data: any) {
        // This is so weird, some messages will be logged as stderr
        // like "Finished test [unoptimized + debuginfo] target(s) in 0.07s"
        // and "Running unittests src\lib.rs (target\debug\deps\hashbrown-3547e1bc587fc63a.exe)"

        // And this make ir hard to use breakpoint to debug, because the buffer will be flushed in unexpected order.
        const normalizedData = normalizeOutputData(data);

        this.testRun.appendOutput(normalizedData);
        console.log(`StdErr:${data}`);

        const lines = normalizedData.split("\r\n");

        lines.forEach(line => {
            this.analyticsCurrentTestTarget(line);
        });
    }

    public onClose() {
        console.log(`Closed`);
        this.testRun.end();
    }

    public onStdOut(data: any) {
        // It seems like the data will be end with a line breaking. Is this promised?
        const normalizedData = normalizeOutputData(data);

        this.testRun.appendOutput(normalizedData);
        console.log(`Stdout:${data}`);

        const lines = normalizedData.split("\r\n");

        lines.forEach(line => {
            this.analyticsTestCaseResult(line);
            this.analyticsStackTrace(line);
        });
    }

    private _currentNormalizedPackageName: string | undefined = undefined;
    private _currentTargetRelativePath: string | undefined = undefined;

    private analyticsCurrentTestTarget(line: string) {
        const match = targetPattern.exec(line); // Running unittests src\\lib.rs (target\\debug\\deps\\hashbrown-3547e1bc587fc63a.exe)
        if (match) {
            this._currentNormalizedPackageName = match?.groups?.[targetPatternNamedCaptureGroup.normalizedPackageName];
            this._currentTargetRelativePath = match?.groups?.[targetPatternNamedCaptureGroup.relativePath];
        }
    }

    private analyticsTestCaseResult(line: string) {
        const match = caseResultPattern.exec(line);
        const rustcCasePath = match?.[1];
        const rustcTestResultString = match?.[2];
        if (rustcCasePath && rustcTestResultString) {
            const rustcTestResult = RustcTestResult.parse(rustcTestResultString);
            const testItem = this._testItemLocator.findTestItemByRustcOutputCasePath(
                this._currentNormalizedPackageName!,
                this._currentTargetRelativePath!,
                rustcCasePath);
            if (!testItem) { return; }
            // TODO: time is only supported in nightly, but we could add them
            switch (rustcTestResult) {
                case RustcTestResult.passed:
                    this.testRun.passed(testItem);
                    break;
                case RustcTestResult.failed:
                    // Mark test item failed
                    // The error message is added later, in `analyticsStackTrace`
                    this.testRun.failed(testItem, []);
                    break;
                case RustcTestResult.ignored:
                    this.testRun.skipped(testItem);
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

    private analyticsStackTrace(line: string) {
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
                    this._currentNormalizedPackageName!,
                    this._currentTargetRelativePath!,
                    rustcCasePath);
                if (!testItem) { assert(false, "Should never happened. Could not bear this error."); }
                this.flushStackTraceAnalytics();
                this._currentFailedRustcOutputTest = testItem;
            }
            this._currentFailedCaseOutputWithStackTrace.push(line);
        }
    }

    private flushStackTraceAnalytics() {
        if (this._currentFailedRustcOutputTest) {
            this.testRun.failed(this._currentFailedRustcOutputTest, new vscode.TestMessage(this._currentFailedCaseOutputWithStackTrace.join('\n')));
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
        const packageNode = workspaceRootNode.members.find(packge => normalizePackageName(packge.name) === packageNormalizedName);
        assert(!!packageNode);
        const targetNode = Array.from(packageNode.targets).find(target => {
            // not accurate, but I think it's enough
            return target.srcPath.fsPath.includes(targetRelativePath);
        });
        assert(!!targetNode);

        const testNode = testModelTree.findTestLikeNodeUnderTarget(
            targetNode,
            NodeKind.Test,
            path.split('::')
        );

        const candidate = getTestItemByTestLikeNode(testNode);

        return candidate;
    }
}

function normalizePackageName(packageName: string) {
    return packageName.replace(/-/g, '_');
}
