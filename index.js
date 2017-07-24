
const TeamcityClient = require("teamcity-client");
const SlackClient = require("@slack/client").WebClient;
const prettyMs = require("pretty-ms");
const filesize = require("filesize");

const listBuilds = async (client, beginWithID) => {
    const {build: unsorted} = await client.build.list({
        project: process.env.TC_PROJECT,
        state: 'finished',
        lookupLimit: 10,
    });
    if (typeof unsorted === "undefined") {
        return [];
    }
    return unsorted
        .sort((build1, build2) => build2.id - build1.id)
        .filter(build => build.id > beginWithID);
};

const slackSend = async (slack, tc, id, channel) => {
    const build = await detailsOfBuild(tc, id);
    return await slack.chat.postMessage(channel, null, {
        attachments: [{
            pretext: pretext(build),
            color: color(build),
            title: title(build),
            title_link: build.webUrl,
            fields: [
                {
                    title: "Duration",
                    value: await durationOfBuild(tc, build.id),
                    short: true
                },
                {
                    title: "Agent",
                    value: agent(build),
                    short: true
                },
                {
                    title: "Status",
                    value: build.statusText,
                    short: true
                },
                {
                    title: "Download",
                    value: await releaseLink(tc, build),
                    short: true
                },
                {
                    title: "Tests",
                    value: await testStatus(tc, build)
                },
                {
                    title: "Commits",
                    value: await commits(tc, build)
                }
            ],
            mrkdwn_in: ["pretext", "fields"]
        }],
    });
};

const agent = (build) => {
    let emoji = ":linux:";
    if (build.projectName.indexOf("osx") !== 0) {
        emoji = ":osx:";
    } else if (build.projectName.indexOf("win") !== 0) {
        emoji = ":windows:"
    }
    return `${emoji} ${build.agent.name}`;
};

const releaseLink = async (client, build) => {
    const {file: files} = await client.httpClient.readJSON(`builds/id:${build.id}/artifacts/children`);
    const fileName = "release.zip";
    const release = files.find(file => file.name === fileName);
    if (!release) {
        return "Release not available";
    }
    return link(
        `https://${process.env.TC_HOST}/repository/download/${build.buildTypeId}/${build.id}:id/${fileName}`,
        `release.zip (${filesize(release.size)})`
    );
};

const durationOfBuild = async (client, id) => {
    const stats = await client.httpClient.readJSON(`builds/id:${id}/statistics`);
    return prettyMs(parseInt(stats.property.find(property => property.name === "BuildDuration").value));
};

const detailsOfBuild = async (client, id) => await client.build.detail({id});

const listTests = async (client, build) => await client.httpClient.readJSON(`testOccurrences?locator=build:${build.id}`);

const detailsOfTest = async (client, id) => await client.httpClient.readJSON(`testOccurrences/${id}`);

const testEmoji = test => test.ignored ? ":okay:" : ":goberserk:";

const failedTestLink = (build, test) => link(
    `${build.webUrl}&tab=buildResultsDiv#testNameId${test.test.id}`,
    `${testEmoji(test)} \`${test.name}\``
);

const testStatus = async (client, build) => {
    let testStatus = ":rollsafe: There were no tests";
    if (typeof build.testOccurrences === "undefined" || !build.testOccurrences.count) {
        return testStatus;
    }
    try {
        const {testOccurrence: tests} = await listTests(client, build);
        const failing = tests.filter(test => test.status !== "SUCCESS");
        if (!failing.length) {
            testStatus = `:awesome: All ${tests.length} tests passed!`;
        } else {
            testStatus = (await Promise.all(
                failing.map(async test => failedTestLink(
                        build,
                        await detailsOfTest(client, test.id)
                    ))
            )).join("\n");
        }
    } catch (err) {
        console.log("ERROR:", err);
    }
    return testStatus;
};

const pretext = build => `*${build.buildType.projectName}* build results:`;

const color = build => build.status === "SUCCESS" ? "good" : "danger";

const title = build => `Build "${build.buildType.name}" #${build.number} ${build.status === "SUCCESS" ? "SUCCEEDED" : "FAILED"}`;

const link = (href, text) => `<${href}|${text}>`;

const commitLink = (revision, version) => link(
        `https://github.com/${revision["vcs-root-instance"].name}/commit/${version}`,
        `\`${version.substring(0, 8)}\``
    );

const commitMessage = async (client, changeId) => {
    const {comment} = await client.httpClient.readJSON(`changes/id:${changeId}`);
    return comment.split("\n")[0];
};

const commits = async (client, build) => {
    if (typeof build.lastChanges === "undefined") {
        return "Nothing changed";
    }
    const commits = await Promise.all(
        build.lastChanges.change
            .map(async (change) => {
                const link = commitLink(build.revisions.revision[0], change.version);
                const message = await commitMessage(client, change.id);
                return `${link} ${message} - _${change.username}_`;
            })
    );
    return commits.join("\n");
};

const main = async () => {
    const tc = new TeamcityClient({
        protocol: "https://",
        host: process.env.TC_HOST,
        user: process.env.TC_USER,
        password: process.env.TC_PASSWORD
    });
    const slack = new SlackClient(process.env.SLACK_TOKEN);
    const channel = process.env.SLACK_CHANNEL;
    const timeout = 10000;

    let beginWithID = 0;
    const lastBuilds = {};
    let running = false;

    const loop = async () => {
        if (running) {
            return;
        }
        running = true;
        try {
            console.log(`searching builds newer than ${beginWithID}`);
            const builds = await listBuilds(tc, beginWithID);
            if (beginWithID === 0 && builds.length) {
                beginWithID = builds[0].id;
                if (process.env.NODE_ENV !== "development") {
                    running = false;
                    return;
                }
            }
            console.log(`found ${builds.length} builds`);
            await Promise.all(
                builds.reverse().map(async (build) => {
                    if (
                        typeof lastBuilds[build.buildTypeId] === 'undefined' ||
                        lastBuilds[build.buildTypeId].id < build.id
                    ) {
                        console.log(`sending notification for ${build.buildTypeId}#${build.number} (id:${build.id})`);
                        try {
                            await slackSend(slack, tc, build.id, channel);
                            lastBuilds[build.buildTypeId] = build.id;
                            console.log('done', lastBuilds);
                        } catch (err) {
                            console.log("SEND ERROR:", err);
                        }
                    }
                })
            );
            running = false;
        } catch (err) {
            console.log("ERROR:", err);
            running = false;
        }
    };

    setInterval(async () => await loop(), timeout);
};

main();