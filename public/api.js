"use strict";

/*
|--------------------------------------------------------------------------|
| api.js — the one fetch wrapper every page uses
|--------------------------------------------------------------------------|
|
| makeApi(token) returns `api(path, options)`:
|
|   - `token` is a string or a function returning the current one, sent as a
|     Bearer header when present;
|   - `options.json` is sent as a JSON body (Content-Type is set);
|   - the parsed JSON body is returned (null when empty, { raw } when it is
|     not JSON);
|   - a non-2xx answer throws an Error carrying `status` and `payload`, with
|     the server's own `error` text as the message.
|--------------------------------------------------------------------------|
*/

const SemanticApi = (function () {

    function makeApi(token) {
        const currentToken = typeof token === "function" ? token : function () { return token; };

        return async function api(path, options) {
            const given = options || {};
            const bearer = currentToken();
            const headers = Object.assign({}, bearer ? { Authorization: "Bearer " + bearer } : {});
            const init = Object.assign({}, given);
            if (given.json !== undefined) {
                headers["Content-Type"] = "application/json";
                init.body = JSON.stringify(given.json);
                delete init.json;
            }
            init.headers = Object.assign(headers, given.headers || {});

            const res = await fetch(path, init);
            const text = await res.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
            if (!res.ok) {
                const error = new Error(
                    String((body && (body.error || body.message || body.raw)) || (res.status + " " + res.statusText).trim())
                );
                error.status = res.status;
                error.payload = body;
                throw error;
            }
            return body;
        };
    }

    return { makeApi: makeApi };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = SemanticApi;
}
