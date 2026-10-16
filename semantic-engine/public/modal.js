"use strict";

/*
| Modal service
| -------------
|
| Three different things in this console need to interrupt the operator:
| settings, an approval request, and the detail of one executed call.
| Written three times they would drift apart, so they share one service.
|
|   Modal.open({ title, subtitle, body, footer })  ->  handle
|
| A modal is a backdrop plus a dialog. The header and the footer are
| optional, because a detail view wants a header and no buttons while an
| approval wants both. Escape and a click on the backdrop close the
| topmost dismissible modal, focus returns to whatever had it before,
| and the page behind stops scrolling while at least one modal is open.
*/

const Modal = (() => {

    const stack = [];


    function escape(value) {

        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }


    function asNode(content) {

        if (content === null || content === undefined) {
            return null;
        }

        if (typeof content === "string") {

            const holder =
                document.createElement("div");

            holder.innerHTML = content;

            return holder;
        }

        return content;
    }


    /*
    | A caller may pass a getter instead of a value when the text is only
    | known at open time. Without this the function itself would be
    | stringified into the header.
    */

    function asText(value) {

        const resolved =
            typeof value === "function" ? value() : value;

        return resolved ?? "";
    }


    function fill(slot, content) {

        slot.innerHTML = "";

        const node = asNode(content);

        if (node) {
            slot.appendChild(node);
        }

        slot.hidden = node === null;
    }


    function top() {

        return stack[stack.length - 1] || null;
    }


    function open(options = {}) {

        const {
            title = null,
            subtitle = null,
            body = null,
            footer = null,
            size = "medium",
            dismissible = true,
            className = "",
            onClose = null
        } = options;

        const backdrop =
            document.createElement("div");

        backdrop.className = "modal-backdrop";

        const dialog =
            document.createElement("div");

        dialog.className =
            `modal modal-${size}${className ? ` ${className}` : ""}`;

        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");

        const header =
            document.createElement("div");

        header.className = "modal-head";

        const heading =
            document.createElement("div");

        heading.className = "modal-title";

        const titleText =
            document.createElement("h2");

        const subtitleText =
            document.createElement("span");

        subtitleText.className = "modal-subtitle";

        heading.append(titleText, subtitleText);

        const closeButton =
            document.createElement("button");

        closeButton.type = "button";
        closeButton.className = "modal-close";
        closeButton.setAttribute("aria-label", "close");
        closeButton.textContent = "✕";

        header.append(heading, closeButton);

        const content =
            document.createElement("div");

        content.className = "modal-body";

        const foot =
            document.createElement("div");

        foot.className = "modal-foot";

        dialog.append(header, content, foot);

        backdrop.appendChild(dialog);

        const previouslyFocused =
            document.activeElement;

        const handle = {
            element: dialog,

            backdrop,

            dismissible,

            isOpen: () => stack.includes(handle),

            setTitle(value) {

                const text = asText(value);

                titleText.textContent = text;

                header.hidden =
                    text === "" &&
                    subtitleText.textContent === "" &&
                    !dismissible;

                return handle;
            },

            setSubtitle(value) {

                const text = asText(value);

                subtitleText.textContent = text;
                subtitleText.hidden = text === "";

                return handle;
            },

            setBody(value) {

                fill(content, value);

                return handle;
            },

            setFooter(value) {

                fill(foot, value);

                return handle;
            },

            close(reason) {

                const index = stack.indexOf(handle);

                if (index === -1) {
                    return;
                }

                stack.splice(index, 1);

                backdrop.remove();

                if (stack.length === 0) {
                    document.body.classList.remove("modal-open");
                }

                if (
                    previouslyFocused &&
                    typeof previouslyFocused.focus === "function"
                ) {
                    previouslyFocused.focus();
                }

                if (typeof onClose === "function") {
                    onClose(reason);
                }
            }
        };

        closeButton.hidden = !dismissible;

        closeButton.addEventListener(
            "click",
            () => handle.close("close-button")
        );

        backdrop.addEventListener("mousedown", event => {

            /*
            | Only a press that starts on the backdrop itself closes, so
            | a text selection dragged out of the dialog does not.
            */

            if (event.target === backdrop && dismissible) {
                handle.close("backdrop");
            }
        });

        handle.setTitle(title);
        handle.setSubtitle(subtitle);
        handle.setBody(body);
        handle.setFooter(footer);

        header.hidden =
            asText(title) === "" &&
            asText(subtitle) === "" &&
            !dismissible;

        document.body.appendChild(backdrop);
        document.body.classList.add("modal-open");

        stack.push(handle);

        const focusable =
            dialog.querySelector(
                "button, input, select, textarea, [tabindex]"
            );

        if (focusable && typeof focusable.focus === "function") {
            focusable.focus();
        }

        return handle;
    }


    function button(label, className, onClick) {

        const element =
            document.createElement("button");

        element.type = "button";
        element.className = className || "";
        element.textContent = label;

        if (onClick) {
            element.addEventListener("click", onClick);
        }

        return element;
    }


    function row(...children) {

        const element =
            document.createElement("div");

        element.className = "modal-row";

        element.append(...children.filter(Boolean));

        return element;
    }


    /*
    | A modal that is not dismissible blocks Escape as well as the
    | backdrop: it is waiting for a decision, and cancelling it by
    | accident is exactly what it exists to prevent.
    */

    function closeTop(reason) {

        const handle = top();

        if (!handle || !handle.dismissible) {
            return false;
        }

        handle.close(reason);

        return true;
    }


    if (typeof document !== "undefined") {

        document.addEventListener("keydown", event => {

            if (event.key === "Escape" && stack.length > 0) {

                event.preventDefault();

                closeTop("escape");
            }

        });
    }


    return {
        open,
        button,
        row,
        escape,
        closeTop,
        get openCount() {
            return stack.length;
        }
    };
})();


if (typeof module !== "undefined" && module.exports) {
    module.exports = Modal;
}
