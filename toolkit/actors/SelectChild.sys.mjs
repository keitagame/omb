/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  LayoutUtils: "resource://gre/modules/LayoutUtils.sys.mjs",
});

const kStateActive = 0x00000001; // ElementState::ACTIVE
const kStateHover = 0x00000004; // ElementState::HOVER

// Duplicated in SelectParent.sys.mjs
// Please keep these lists in sync.
const SUPPORTED_OPTION_OPTGROUP_PROPERTIES = [
  "direction",
  "color",
  "background-color",
  "text-shadow",
  "text-transform",
  "font-family",
  "font-weight",
  "font-size",
  "font-style",
];

const SUPPORTED_SELECT_PROPERTIES = [
  ...SUPPORTED_OPTION_OPTGROUP_PROPERTIES,
  "scrollbar-width",
  "scrollbar-color",
];

// A process global state for whether or not content thinks
// that a <select> dropdown is open or not. This is managed
// entirely within this module, and is read-only accessible
// via SelectContentHelper.open.
var gOpen = false;

export var SelectContentHelper = function (aElement, aOptions, aActor) {
  this.element = aElement;
  this.initialSelection = aElement[aElement.selectedIndex] || null;
  this.actor = aActor;
  this.closedWithClickOn = false;
  this.isOpenedViaTouch = aOptions.isOpenedViaTouch;
  this._closeAfterBlur = true;
  this._pseudoStylesSetup = false;
  this.init();
  this.showDropDown();
  this._updateTimer = new lazy.DeferredTask(this._update.bind(this), 0);
};

Object.defineProperty(SelectContentHelper, "open", {
  get() {
    return gOpen;
  },
});

SelectContentHelper.prototype = {
  init() {
    let win = this.element.ownerGlobal;
    win.addEventListener("pagehide", this, { mozSystemGroup: true });
    this.element.addEventListener("blur", this, { mozSystemGroup: true });
    this.element.addEventListener("transitionend", this, {
      mozSystemGroup: true,
    });
    let MutationObserver = this.element.ownerGlobal.MutationObserver;
    this.mut = new MutationObserver(() => {
      // Something changed the <select> while it was open, so
      // we'll poke a DeferredTask to update the parent sometime
      // in the very near future.
      this._updateTimer.arm();
    });
    this.mut.observe(this.element, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "disablePopupAutohide",
      "ui.popup.disable_autohide",
      false
    );
  },

  uninit() {
    this.element.openInParentProcess = false;
    let win = this.element.ownerGlobal;
    win.removeEventListener("pagehide", this, { mozSystemGroup: true });
    this.element.removeEventListener("blur", this, { mozSystemGroup: true });
    this.element.removeEventListener("transitionend", this, {
      mozSystemGroup: true,
    });
    this.element = null;
    this.actor = null;
    this.mut.disconnect();
    this._updateTimer.disarm();
    this._updateTimer = null;
    gOpen = false;
  },

  showDropDown() {
    this.element.openInParentProcess = true;
    this._setupPseudoClassStyles();
    let rect = this._getBoundingContentRect();
    let computedStyles = getComputedStyles(this.element);
    let options = this._buildOptionList();
    let defaultStyles = this.element.ownerGlobal.getDefaultComputedStyle(
      this.element
    );
    this.actor.sendAsyncMessage("Forms:ShowDropDown", {
      isOpenedViaTouch: this.isOpenedViaTouch,
      options,
      rect,
      custom: !this.element.nodePrincipal.isSystemPrincipal,
      selectedIndex: this.element.selectedIndex,
      isDarkBackground: ChromeUtils.isDarkBackground(this.element),
      style: supportedStyles(computedStyles, SUPPORTED_SELECT_PROPERTIES),
      defaultStyle: supportedStyles(defaultStyles, SUPPORTED_SELECT_PROPERTIES),
    });
    this._clearPseudoClassStyles();
    gOpen = true;
  },

  _setupPseudoClassStyles() {
    if (this._pseudoStylesSetup) {
      throw new Error("pseudo styles must not be set up yet");
    }
    // Do all of the things that change style at once, before we read
    // any styles.
    this._pseudoStylesSetup = true;
    InspectorUtils.addPseudoClassLock(this.element, ":focus");
  },

  _clearPseudoClassStyles() {
    if (!this._pseudoStylesSetup) {
      throw new Error("pseudo styles must be set up already");
    }
    // Undo all of the things that change style at once, after we're
    // done reading styles.
    InspectorUtils.clearPseudoClassLocks(this.element);
    this._pseudoStylesSetup = false;
  },

  _getBoundingContentRect() {
    return lazy.LayoutUtils.getElementBoundingScreenRect(this.element);
  },

  _buildOptionList() {
    if (!this._pseudoStylesSetup) {
      throw new Error("pseudo styles must be set up");
    }
    let uniqueStyles = [];
    let options = buildOptionListForChildren(this.element, uniqueStyles);
    return { options, uniqueStyles };
  },

  _update() {
    // The <select> was updated while the dropdown was open.
    // Let's send up a new list of options.
    // Technically we might not need to set this pseudo-class
    // during _update() since the element should organically
    // have :focus, though it is here for belt-and-suspenders.
    this._setupPseudoClassStyles();
    let computedStyles = getComputedStyles(this.element);
    let defaultStyles = this.element.ownerGlobal.getDefaultComputedStyle(
      this.element
    );
    this.actor.sendAsyncMessage("Forms:UpdateDropDown", {
      options: this._buildOptionList(),
      custom: !this.element.nodePrincipal.isSystemPrincipal,
      selectedIndex: this.element.selectedIndex,
      isDarkBackground: ChromeUtils.isDarkBackground(this.element),
      style: supportedStyles(computedStyles, SUPPORTED_SELECT_PROPERTIES),
      defaultStyle: supportedStyles(defaultStyles, SUPPORTED_SELECT_PROPERTIES),
    });
    this._clearPseudoClassStyles();
  },

  dispatchMouseEvent(win, target, eventName) {
    let dict = {
      view: win,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    let mouseEvent =
      eventName == "click"
        ? new win.PointerEvent(eventName, dict)
        : new win.MouseEvent(eventName, dict);
    target.dispatchEvent(mouseEvent);
  },

  receiveMessage(message) {
    switch (message.name) {
      case "Forms:SelectDropDownItem":
        this.element.selectedIndex = message.data.value;
        this.closedWithClickOn = !message.data.closedWithEnter;
        break;

      case "Forms:DismissedDropDown": {
        if (!this.element) {
          return;
        }

        let win = this.element.ownerGlobal;

        // Running arbitrary script below (dispatching events for example) can
        // close us, but we should still send events consistently.
        let element = this.element;

        let selectedOption = element.item(element.selectedIndex);

        // For ordering of events, we're using non-e10s as our guide here,
        // since the spec isn't exactly clear. In non-e10s:
        // - If the user clicks on an element in the dropdown, we fire
        //   mousedown, mouseup, input, change, and click events.
        // - If the user uses the keyboard to select an element in the
        //   dropdown, we only fire input and change events.
        // - If the user pressed ESC key or clicks outside the dropdown,
        //   we fire nothing as the selected option is unchanged.
        if (this.closedWithClickOn) {
          this.dispatchMouseEvent(win, selectedOption, "mousedown");
          this.dispatchMouseEvent(win, selectedOption, "mouseup");
        }

        // Clear active document no matter user selects via keyboard or mouse
        InspectorUtils.removeContentState(
          element,
          kStateActive,
          /* aClearActiveDocument */ true
        );

        // Fire input and change events when selected option changes
        {
          let changed = this.initialSelection !== selectedOption;
          let handlingUserInput = win.windowUtils.setHandlingUserInput(changed);
          try {
            element.userFinishedInteracting(changed);
          } finally {
            handlingUserInput.destruct();
          }
        }

        // Fire click event
        if (this.closedWithClickOn) {
          this.dispatchMouseEvent(win, selectedOption, "click");
        }

        this.uninit();
        break;
      }

      case "Forms:MouseOver":
        InspectorUtils.setContentState(this.element, kStateHover);
        break;

      case "Forms:MouseOut":
        InspectorUtils.removeContentState(this.element, kStateHover);
        break;

      case "Forms:MouseUp": {
        let win = this.element.ownerGlobal;
        if (message.data.onAnchor) {
          this.dispatchMouseEvent(win, this.element, "mouseup");
        }
        InspectorUtils.removeContentState(this.element, kStateActive);
        if (message.data.onAnchor) {
          this.dispatchMouseEvent(win, this.element, "click");
        }
        break;
      }

      case "Forms:SearchFocused":
        this._closeAfterBlur = false;
        break;

      case "Forms:BlurDropDown-Pong":
        if (!this._closeAfterBlur || !gOpen) {
          return;
        }
        this.actor.sendAsyncMessage("Forms:HideDropDown", {});
        this.uninit();
        break;
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "pagehide":
        if (this.element.ownerDocument === event.target) {
          this.actor.sendAsyncMessage("Forms:HideDropDown", {});
          this.uninit();
        }
        break;
      case "blur": {
        if (this.element !== event.target || this.disablePopupAutohide) {
          break;
        }
        this._closeAfterBlur = true;
        // Send a ping-pong message to make sure that we wait for
        // enough cycles to pass from the potential focusing of the
        // search box to disable closing-after-blur.
        this.actor.sendAsyncMessage("Forms:BlurDropDown-Ping", {});
        break;
      }
      case "mozhidedropdown":
        if (this.element === event.target) {
          this.actor.sendAsyncMessage("Forms:HideDropDown", {});
          this.uninit();
        }
        break;
      case "transitionend":
        if (
          this.element === event.target &&
          SUPPORTED_SELECT_PROPERTIES.includes(event.propertyName)
        ) {
          this._updateTimer.arm();
        }
        break;
    }
  },
};

function getComputedStyles(element) {
  return element.ownerGlobal.getComputedStyle(element);
}

function supportedStyles(cs, supportedProps) {
  let styles = {};
  for (let property of supportedProps) {
    if (property == "font-size") {
      let usedSize = cs.usedFontSize;
      if (usedSize >= 0.0) {
        styles[property] = usedSize + "px";
        continue;
      }
    }
    styles[property] = cs.getPropertyValue(property);
  }
  return styles;
}

function supportedStylesEqual(styles, otherStyles) {
  for (let property in styles) {
    if (styles[property] !== otherStyles[property]) {
      return false;
    }
  }
  return true;
}

function uniqueStylesIndex(cs, uniqueStyles) {
  let styles = supportedStyles(cs, SUPPORTED_OPTION_OPTGROUP_PROPERTIES);
  for (let i = uniqueStyles.length; i--; ) {
    if (supportedStylesEqual(uniqueStyles[i], styles)) {
      return i;
    }
  }
  uniqueStyles.push(styles);
  return uniqueStyles.length - 1;
}

function buildOptionListForChildren(node, uniqueStyles) {
  let result = [];

  let lastWasHR = false;
  for (let child of node.children) {
    let className = ChromeUtils.getClassName(child);
    let isOption = className == "HTMLOptionElement";
    let isOptGroup = className == "HTMLOptGroupElement";
    let isHR = className == "HTMLHRElement";
    if (!isOption && !isOptGroup && !isHR) {
      continue;
    }
    if (child.hidden) {
      continue;
    }

    let cs = getComputedStyles(child);

    if (isHR) {
      // https://html.spec.whatwg.org/#the-select-element-2
      // "Each sequence of one or more child hr element siblings may be rendered as a single separator."
      if (lastWasHR) {
        continue;
      }

      let info = {
        index: child.index,
        display: cs.display,
        isHR,
      };

      const defaultHRStyle = node.ownerGlobal.getDefaultComputedStyle(child);
      if (cs.color != defaultHRStyle.color) {
        info.color = cs.color;
      }

      result.push(info);

      lastWasHR = true;
      continue;
    }
    lastWasHR = false;

    // The option code-path should match HTMLOptionElement::GetRenderedLabel.
    let textContent = isOptGroup
      ? child.getAttribute("label")
      : child.label || child.text;
    if (textContent == null) {
      textContent = "";
    }

    let info = {
      index: child.index,
      isOptGroup,
      textContent,
      disabled: child.disabled,
      display: cs.display,
      tooltip: child.title,
      children: isOptGroup
        ? buildOptionListForChildren(child, uniqueStyles)
        : [],
      // Most options have the same style. In order to reduce the size of the
      // IPC message, coalesce them in uniqueStyles.
      styleIndex: uniqueStylesIndex(cs, uniqueStyles),
    };
    result.push(info);
  }
  return result;
}

// Hold the instance of SelectContentHelper created
// when the dropdown list is opened. This variable helps
// re-route the received message from SelectChild to SelectContentHelper object.
let currentSelectContentHelper = new WeakMap();

export class SelectChild extends JSWindowActorChild {
  handleEvent(event) {
    if (SelectContentHelper.open) {
      // The SelectContentHelper object handles captured
      // events when the <select> popup is open.
      let contentHelper = currentSelectContentHelper.get(this);
      if (contentHelper) {
        contentHelper.handleEvent(event);
      }
      return;
    }

    switch (event.type) {
      case "mozshowdropdown": {
        let contentHelper = new SelectContentHelper(
          event.target,
          { isOpenedViaTouch: false },
          this
        );
        currentSelectContentHelper.set(this, contentHelper);
        break;
      }

      case "mozshowdropdown-sourcetouch": {
        let contentHelper = new SelectContentHelper(
          event.target,
          { isOpenedViaTouch: true },
          this
        );
        currentSelectContentHelper.set(this, contentHelper);
        break;
      }
    }
  }

  receiveMessage(message) {
    let contentHelper = currentSelectContentHelper.get(this);
    if (contentHelper) {
      contentHelper.receiveMessage(message);
    }
  }
}
