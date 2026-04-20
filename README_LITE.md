# Background

This repository is a fork of [Career-Ops](https://github.com/santifer/career-ops).

It is a modified version of the original repository with a goal of optimizing token usage.

The main changes are:

- Implementing a SQLite3 database (with Drizzle ORM) to store application and pipeline data. This reduces the need to load the entire markdown into memory for manipulation, sorting, or changes.
- UI for looking through the same.
- JS Scripts to allow the LLM to interact with the database
- Extracting out unnecessary content from Claude/Skills to reduce token usage. They are instead loaded only in the instances they are required.
- Optimize web requests and searches for JD's to reduce token usage. Abstract them into a subagent.

---

I have no affiliation with the original author nor do I claim ownership of the original repository. I am simply using it as a base for my own modifications.

In addition, this is still a work in progress and may not yield the improvements I'm hoping for. I'm documenting my progress here for others to see. To that effect, this will most likely not become a pull requestin to the main repository. I will attempt to keep it up to date with Santifer's main branch as much as possible but there are some things that are out of scope including:

- non-English support
- LLM integration besides Claude.
