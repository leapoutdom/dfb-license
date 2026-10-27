(() => {
  "use strict";

  const config = window.LICENSE_PORTAL_CONFIG || {};
  const endpoint = `${String(config.supabaseUrl || "").replace(/\/+$/, "")}/functions/v1/license`;
  const formMessage = document.getElementById("portal-message");
  const authSplash = document.getElementById("auth-splash");
  const processingOverlay = document.getElementById("processing-overlay");
  const processingMessage = document.getElementById("processing-message");
  const portalShell = document.querySelector(".portal-shell");
  const loginMessage = document.getElementById("login-message");
  const dashboard = document.getElementById("admin-dashboard");
  const authScreen = document.getElementById("auth-screen");
  const adminLoginButton = document.getElementById("admin-login");
  const rememberLoginCheckbox = document.getElementById("remember-admin-login");
  const confirmDialog = document.getElementById("confirm-dialog");
  const issuedKeyDialog = document.getElementById("issued-key-dialog");
  const renewalDialog = document.getElementById("renew-license-dialog");
  const rememberedSessionKey = "dfb-license-admin-session";
  const activeDevicePageSize = 12;
  let accessToken = "";
  let refreshToken = "";
  let adminEmail = "";
  let licenses = [];
  let busy = false;
  let confirmResolver = null;
  let renewalLicenseId = "";
  let hasLoadedAdminData = false;
  let pullStartY = null;
  let pullDistance = 0;
  let pullRefreshing = false;
  let allActiveDeviceRecords = [];
  let activeDeviceRecords = [];
  let activeDeviceRenderedCount = 0;
  let activeDeviceObserver = null;
  if ("serviceWorker" in navigator && window.isSecureContext) {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((error) => {
      console.error("Admin portal service worker registration failed.", error);
    });
  }

  function setStatus(element, message, kind = "") {
    element.textContent = message;
    element.className = `form-message${kind ? ` is-${kind}` : ""}`;
  }

  function setPortalMessage(message, kind = "") {
    formMessage.textContent = message;
    formMessage.className = `portal-message${kind ? ` is-${kind}` : ""}`;
    formMessage.hidden = !message;
  }

  function setAuthSplashStep(step, message) {
    document.getElementById("auth-splash-message").textContent = message;
    const steps = ["session", "access", "workspace"];
    const activeIndex = steps.indexOf(step);
    document.querySelectorAll("[data-auth-step]").forEach((item) => {
      const itemIndex = steps.indexOf(item.dataset.authStep);
      item.classList.toggle("is-complete", itemIndex < activeIndex);
      item.classList.toggle("is-current", itemIndex === activeIndex);
    });
  }

  function finishAuthSplash() {
    authSplash.hidden = true;
    document.body.classList.remove("is-checking-auth");
  }

  function configReady() {
    return typeof config.supabaseUrl === "string"
      && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.supabaseUrl)
      && typeof config.supabaseAnonKey === "string"
      && config.supabaseAnonKey.length > 20
      && !config.supabaseAnonKey.startsWith("REPLACE_");
  }

  async function parseResponse(response) {
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("The license service returned an invalid response.");
    }
    if (!response.ok || result.error) {
      const error = new Error(result.msg || result.error_description || result.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function requestAuth(path, body) {
    const response = await fetch(`${String(config.supabaseUrl).replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      cache: "no-store",
      body: JSON.stringify(body),
    });
    return parseResponse(response);
  }

  function clearRememberedSession() {
    try {
      localStorage.removeItem(rememberedSessionKey);
      return "";
    } catch (error) {
      return `Could not clear the remembered session: ${error?.message || error}`;
    }
  }

  function persistRememberedSession() {
    if (!rememberLoginCheckbox.checked) return clearRememberedSession();
    if (!refreshToken) return "Supabase did not provide a refresh token, so this session cannot be remembered.";
    try {
      localStorage.setItem(rememberedSessionKey, JSON.stringify({
        refresh_token: refreshToken,
        email: adminEmail,
      }));
      return "";
    } catch (error) {
      return `Signed in, but the session could not be remembered: ${error?.message || error}`;
    }
  }

  function setAuthSession(session, fallbackEmail = "") {
    if (typeof session.access_token !== "string" || !session.access_token) {
      throw new Error("Supabase Auth returned no access token.");
    }
    accessToken = session.access_token;
    refreshToken = typeof session.refresh_token === "string" ? session.refresh_token : "";
    adminEmail = session.user?.email || fallbackEmail;
    return persistRememberedSession();
  }

  async function callFunction(payload, requireAdmin = true) {
    const headers = { "Content-Type": "application/json" };
    if (requireAdmin) {
      if (!accessToken) throw new Error("Sign in to continue.");
      headers.Authorization = `Bearer ${accessToken}`;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(payload),
    });
    const result = await parseResponse(response);
    if (result.ok !== true) throw new Error("The license service rejected the request.");
    return result;
  }

  function setBusy(value, message = "Processing your request…", showOverlay = true) {
    busy = value;
    adminLoginButton.disabled = value;
    document.getElementById("refresh-admin").disabled = value;
    document.querySelectorAll(".admin-action").forEach((button) => {
      button.disabled = value;
    });
    portalShell.inert = value && showOverlay;
    processingOverlay.hidden = !value || !showOverlay;
    if (value) processingMessage.textContent = message;
  }

  function showConfirm(title, description, detail, label = "Continue") {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-description").textContent = description;
    const detailElement = document.getElementById("confirm-detail");
    detailElement.textContent = detail || "";
    detailElement.hidden = !detail;
    document.getElementById("confirm-action").textContent = label;
    confirmDialog.showModal();
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  confirmDialog.addEventListener("close", () => {
    if (confirmResolver) {
      confirmResolver(confirmDialog.returnValue === "confirm");
      confirmResolver = null;
    }
  });

  async function runAdminAction(action, successMessage = "", { showOverlay = true } = {}) {
    if (busy) return null;
    const activityMessages = {
      admin_list: "Loading your license workspace…",
      admin_issue: "Generating a new license key…",
      admin_revoke_device: "Revoking device activation…",
      admin_set_license: "Updating license settings…",
    };
    setBusy(true, activityMessages[action.action] || "Processing your request…", showOverlay);
    setPortalMessage("");
    try {
      const result = await callFunction(action);
      if (successMessage) setPortalMessage(successMessage, "success");
      return result;
    } catch (error) {
      setPortalMessage(error.message, "error");
      if (/session is invalid|sign in with an administrator|not authorized/i.test(error.message)) {
        signOut(false);
        setStatus(loginMessage, error.message, "error");
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadAdminData({ showOverlay = true, showSkeleton = false } = {}) {
    if (busy) return;
    const refreshButton = document.getElementById("refresh-admin");
    refreshButton.classList.add("is-refreshing");
    if (showSkeleton) {
      refreshSkeleton.dataset.view = dashboard.querySelector(".admin-view:not([hidden])")?.id || "home-view";
      refreshSkeleton.hidden = false;
      dashboard.classList.add("is-skeleton-loading");
      dashboard.setAttribute("aria-busy", "true");
    }
    try {
      const result = await runAdminAction({ action: "admin_list" }, "", { showOverlay });
      if (!result) return;
      licenses = Array.isArray(result.licenses) ? result.licenses : [];
      adminEmail = result.admin_email || adminEmail;
      document.getElementById("admin-account-email").textContent = adminEmail;
      renderLicenses();
      renderActiveDevices();
      renderRenewals();
      renderDashboard();
      if (!hasLoadedAdminData) {
        showAdminView("home-view");
        hasLoadedAdminData = true;
      }
      document.body.classList.add("is-admin-authenticated");
      refreshButton.hidden = false;
      authScreen.hidden = true;
      dashboard.hidden = false;
    } finally {
      if (showSkeleton) {
        dashboard.classList.remove("is-skeleton-loading");
        dashboard.removeAttribute("aria-busy");
        refreshSkeleton.hidden = true;
      }
      refreshButton.classList.remove("is-refreshing");
    }
  }

  function formatDate(value) {
    if (!value) return "No expiry";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Unknown date"
      : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function licenseIsUsable(license) {
    return Boolean(license.is_active)
      && (!license.expires_at || new Date(license.expires_at).getTime() > Date.now());
  }

  function expiringLicenses(includeExpired = false) {
    const now = Date.now();
    const limit = now + 7 * 24 * 60 * 60 * 1000;
    return licenses.filter((license) => {
      if (!license.expires_at) return false;
      const expiresAt = new Date(license.expires_at).getTime();
      return !Number.isNaN(expiresAt) && expiresAt <= limit && (includeExpired || expiresAt > now);
    });
  }

  function dateInputValue(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function getCustomerInfo(license) {
    const customer = { ...license.request_contact, ...license.customer_info };
    if (!customer || typeof customer !== "object") return [];
    return [
      ["Name", customer.name],
      ["Email", customer.email],
      ["Phone", customer.phone],
      ["Telegram", customer.telegram],
    ].filter(([, value]) => typeof value === "string" && value.trim());
  }

  function makeLimitSelect(value) {
    const select = document.createElement("select");
    for (const limit of [1, 3, 5]) {
      const option = document.createElement("option");
      option.value = String(limit);
      option.textContent = `${limit} device${limit === 1 ? "" : "s"}`;
      option.selected = Number(value) === limit;
      select.append(option);
    }
    return makeSelectControl(select);
  }

  function makeDateInput(value) {
    const input = document.createElement("input");
    input.className = "compact-date";
    input.type = "date";
    input.value = dateInputValue(value);
    return { input, element: makeDatePicker(input) };
  }

  function makeSelectControl(select) {
    select.classList.add("native-select-value");
    select.tabIndex = -1;
    select.hidden = true;
    select.setAttribute("aria-hidden", "true");
    const wrapper = makeElement("div", "select-control");
    const trigger = makeElement("button", "select-control-trigger");
    trigger.type = "button";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const menu = makeElement("div", "select-control-menu");
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    const menuId = `select-options-${Math.random().toString(36).slice(2)}`;
    menu.id = menuId;
    trigger.setAttribute("aria-controls", menuId);

    let repositionMenu = null;
    let popupDialog = null;
    let closeOnOutsideClick = null;
    const close = () => {
      if (!menu.hidden && repositionMenu) {
        window.removeEventListener("resize", repositionMenu);
        window.removeEventListener("scroll", repositionMenu, true);
        repositionMenu = null;
      }
      if (closeOnOutsideClick) {
        document.removeEventListener("pointerdown", closeOnOutsideClick);
        closeOnOutsideClick = null;
      }
      if (popupDialog) {
        popupDialog.removeEventListener("close", close);
        popupDialog = null;
      }
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      wrapper.classList.remove("is-open");
      menu.style.position = "";
      menu.style.top = "";
      menu.style.bottom = "";
      menu.style.left = "";
      menu.style.width = "";
      menu.style.maxHeight = "";
      wrapper.insertBefore(menu, select);
    };
    const positionMenu = () => {
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const dialogRect = popupDialog?.getBoundingClientRect();
      const bounds = dialogRect
        ? { top: dialogRect.top, bottom: dialogRect.bottom, left: dialogRect.left, right: dialogRect.right }
        : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
      const availableBelow = Math.max(0, bounds.bottom - rect.bottom - margin);
      const availableAbove = Math.max(0, rect.top - bounds.top - margin);
      const desiredHeight = Math.min(menu.scrollHeight, 300);
      const placeBelow = availableBelow >= desiredHeight || availableBelow >= availableAbove;
      const availableHeight = placeBelow ? availableBelow : availableAbove;
      menu.style.position = popupDialog ? "absolute" : "fixed";
      const left = Math.max(bounds.left + margin, Math.min(rect.left, bounds.right - rect.width - margin));
      menu.style.left = `${left - (dialogRect?.left ?? 0)}px`;
      menu.style.width = `${rect.width}px`;
      menu.style.maxHeight = `${Math.max(40, Math.min(300, availableHeight))}px`;
      menu.style.top = placeBelow ? `${rect.bottom - (dialogRect?.top ?? 0) + 6}px` : "auto";
      menu.style.bottom = placeBelow ? "auto" : `${(dialogRect?.bottom ?? window.innerHeight) - rect.top + 6}px`;
    };
    const refresh = () => {
      const selected = select.selectedOptions[0];
      trigger.textContent = selected?.textContent || "";
      menu.querySelectorAll('[role="option"]').forEach((option) => {
        const isSelected = option.dataset.value === select.value;
        option.setAttribute("aria-selected", String(isSelected));
        option.classList.toggle("is-selected", isSelected);
      });
    };

    Array.from(select.options).forEach((option) => {
      const item = makeElement("button", "select-control-option", option.textContent);
      item.type = "button";
      item.setAttribute("role", "option");
      item.dataset.value = option.value;
      item.addEventListener("click", () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        refresh();
        close();
        trigger.focus();
      });
      menu.append(item);
    });
    trigger.addEventListener("click", () => {
      const opening = menu.hidden;
      if (!opening) {
        close();
        return;
      }
      document.querySelectorAll(".select-control-menu:not([hidden])").forEach((openMenu) => {
        openMenu.dispatchEvent(new Event("close-select"));
      });
      menu.hidden = false;
      popupDialog = trigger.closest("dialog");
      (popupDialog || document.body).append(menu);
      popupDialog?.addEventListener("close", close, { once: true });
      trigger.setAttribute("aria-expanded", String(opening));
      wrapper.classList.toggle("is-open", opening);
      positionMenu();
      repositionMenu = positionMenu;
      window.addEventListener("resize", repositionMenu);
      window.addEventListener("scroll", repositionMenu, true);
      closeOnOutsideClick = (event) => {
        const target = event.target;
        if (target instanceof Node && !wrapper.contains(target) && !menu.contains(target)) close();
      };
      document.addEventListener("pointerdown", closeOnOutsideClick);
      menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      if (menu.hidden) {
        trigger.click();
        return;
      }
      const options = Array.from(menu.querySelectorAll('[role="option"]'));
      const selectedIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
      const nextIndex = event.key === "ArrowUp"
        ? Math.max(0, selectedIndex - 1)
        : Math.min(options.length - 1, selectedIndex + 1);
      if (event.key === "Enter" || event.key === " ") {
        options[selectedIndex]?.click();
      } else {
        options[nextIndex]?.focus();
      }
    });
    menu.addEventListener("keydown", (event) => {
      const options = Array.from(menu.querySelectorAll('[role="option"]'));
      const optionIndex = options.indexOf(event.target);
      if (event.key === "Escape") {
        close();
        trigger.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const nextIndex = event.key === "ArrowDown"
          ? Math.min(options.length - 1, optionIndex + 1)
          : Math.max(0, optionIndex - 1);
        options[nextIndex]?.focus();
      }
    });
    menu.addEventListener("close-select", close);
    select.addEventListener("change", refresh);
    wrapper.append(trigger, menu, select);
    refresh();
    return { element: wrapper, select };
  }

  function makeDatePicker(input) {
    input.classList.add("native-date-value");
    input.tabIndex = -1;
    input.hidden = true;
    input.setAttribute("aria-hidden", "true");
    const wrapper = makeElement("div", "date-picker");
    const trigger = makeElement("button", "date-picker-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    const popup = makeElement("div", "date-picker-popup");
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Choose expiry date");
    popup.hidden = true;
    const heading = makeElement("div", "date-picker-heading");
    const previous = makeElement("button", "date-picker-month-button", "‹");
    previous.type = "button";
    previous.setAttribute("aria-label", "Previous month");
    const monthLabel = makeElement("button", "date-picker-month");
    monthLabel.type = "button";
    monthLabel.setAttribute("aria-label", "Choose month and year");
    const next = makeElement("button", "date-picker-month-button", "›");
    next.type = "button";
    next.setAttribute("aria-label", "Next month");
    heading.append(previous, monthLabel, next);
    const weekdays = makeElement("div", "date-picker-weekdays");
    for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      weekdays.append(makeElement("span", "", day));
    }
    const days = makeElement("div", "date-picker-days");
    const monthChooser = makeElement("div", "date-picker-months");
    const yearChooser = makeElement("div", "date-picker-years");
    popup.append(heading, weekdays, days, monthChooser, yearChooser);
    wrapper.append(trigger, popup, input);

    const parseValue = () => {
      if (!input.value) return null;
      const [year, month, day] = input.value.split("-").map(Number);
      return new Date(year, month - 1, day);
    };
    let visibleMonth = parseValue() || new Date();
    let pickerView = "days";
    let yearRangeStart = visibleMonth.getFullYear() - 6;
    const formatValue = (date) => date.toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
    const updateTrigger = () => {
      trigger.replaceChildren();
      const selectedDate = parseValue();
      const value = makeElement(
        "span",
        `date-picker-value${selectedDate ? "" : " is-placeholder"}`,
        selectedDate ? formatValue(selectedDate) : "Select a date",
      );
      trigger.append(
        value,
        makeElement("span", "date-picker-icon", "▦"),
      );
    };
    const renderMonth = () => {
      pickerView = "days";
      popup.dataset.view = pickerView;
      monthLabel.textContent = visibleMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      monthLabel.setAttribute("aria-label", "Choose month and year");
      days.replaceChildren();
      const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
      const start = new Date(first);
      start.setDate(1 - first.getDay());
      const selected = parseValue();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        const day = makeElement("button", "date-picker-day", String(date.getDate()));
        day.type = "button";
        day.setAttribute("aria-label", date.toLocaleDateString(undefined, { dateStyle: "full" }));
        const currentMonth = date.getMonth() === visibleMonth.getMonth();
        const isSelected = selected
          && date.getFullYear() === selected.getFullYear()
          && date.getMonth() === selected.getMonth()
          && date.getDate() === selected.getDate();
        day.classList.toggle("is-outside-month", !currentMonth);
        day.classList.toggle("is-selected", Boolean(isSelected));
        day.classList.toggle("is-today", date.getTime() === today.getTime());
        day.setAttribute("aria-pressed", String(Boolean(isSelected)));
        day.addEventListener("click", () => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          const dayValue = String(date.getDate()).padStart(2, "0");
          input.value = `${year}-${month}-${dayValue}`;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          visibleMonth = new Date(year, date.getMonth(), 1);
          updateTrigger();
          popup.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
          wrapper.classList.remove("is-open");
          trigger.focus();
        });
        days.append(day);
      }
    };
    const renderMonths = () => {
      pickerView = "months";
      popup.dataset.view = pickerView;
      monthLabel.textContent = String(visibleMonth.getFullYear());
      monthLabel.setAttribute("aria-label", "Choose year");
      weekdays.replaceChildren();
      days.replaceChildren();
      monthChooser.replaceChildren();
      yearChooser.replaceChildren();
      const selectedMonth = parseValue();
      for (let month = 0; month < 12; month += 1) {
        const item = makeElement("button", "date-picker-month-option",
          new Date(visibleMonth.getFullYear(), month, 1).toLocaleDateString(undefined, { month: "short" }));
        item.type = "button";
        const selected = selectedMonth
          && selectedMonth.getFullYear() === visibleMonth.getFullYear()
          && selectedMonth.getMonth() === month;
        item.classList.toggle("is-selected", Boolean(selected));
        item.setAttribute("aria-pressed", String(Boolean(selected)));
        item.addEventListener("click", () => {
          visibleMonth = new Date(visibleMonth.getFullYear(), month, 1);
          renderMonth();
        });
        monthChooser.append(item);
      }
    };
    const renderYears = () => {
      pickerView = "years";
      popup.dataset.view = pickerView;
      monthLabel.textContent = `${yearRangeStart}–${yearRangeStart + 11}`;
      monthLabel.setAttribute("aria-label", "Choose year range");
      weekdays.replaceChildren();
      days.replaceChildren();
      monthChooser.replaceChildren();
      yearChooser.replaceChildren();
      const selectedDate = parseValue();
      for (let year = yearRangeStart; year < yearRangeStart + 12; year += 1) {
        const item = makeElement("button", "date-picker-year-option", String(year));
        item.type = "button";
        const selected = selectedDate?.getFullYear() === year;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-pressed", String(selected));
        item.addEventListener("click", () => {
          visibleMonth = new Date(year, visibleMonth.getMonth(), 1);
          yearRangeStart = year - 6;
          renderMonths();
        });
        yearChooser.append(item);
      }
    };
    trigger.addEventListener("click", () => {
      const opening = popup.hidden;
      popup.hidden = !opening;
      trigger.setAttribute("aria-expanded", String(opening));
      wrapper.classList.toggle("is-open", opening);
      if (opening) {
        visibleMonth = parseValue() || new Date();
        renderMonth();
      }
    });
    previous.addEventListener("click", () => {
      if (pickerView === "years") {
        yearRangeStart -= 12;
        renderYears();
      } else if (pickerView === "months") {
        visibleMonth = new Date(visibleMonth.getFullYear() - 1, visibleMonth.getMonth(), 1);
        renderMonths();
      } else {
        visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
        renderMonth();
      }
    });
    next.addEventListener("click", () => {
      if (pickerView === "years") {
        yearRangeStart += 12;
        renderYears();
      } else if (pickerView === "months") {
        visibleMonth = new Date(visibleMonth.getFullYear() + 1, visibleMonth.getMonth(), 1);
        renderMonths();
      } else {
        visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
        renderMonth();
      }
    });
    monthLabel.addEventListener("click", () => {
      if (pickerView === "days") renderMonths();
      else if (pickerView === "months") {
        yearRangeStart = visibleMonth.getFullYear() - 6;
        renderYears();
      } else renderMonths();
    });
    input.addEventListener("change", updateTrigger);
    updateTrigger();
    return wrapper;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Continue with the selection-based fallback when browser clipboard access is denied.
      }
    }
    const fallback = document.createElement("textarea");
    const previousFocus = document.activeElement;
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    fallback.style.pointerEvents = "none";
    document.body.append(fallback);
    let copied = false;
    try {
      fallback.focus();
      fallback.select();
      fallback.setSelectionRange(0, text.length);
      copied = typeof document.execCommand === "function" && document.execCommand("copy");
    } finally {
      fallback.remove();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    }
    if (!copied) throw new Error("Clipboard access is unavailable in this browser.");
  }

  function makeActionButton(text, kind, onClick, ariaLabel = text) {
    const button = makeElement("button", `admin-action ${kind}`, text);
    button.type = "button";
    button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", onClick);
    return button;
  }

  function showAdminView(viewId) {
    document.querySelectorAll(".admin-view").forEach((view) => {
      view.hidden = view.id !== viewId;
    });
    const pageTitles = {
      "home-view": "Home dashboard",
      "active-devices-view": "Active devices",
      "licenses-view": "Device licenses",
      "generate-view": "Generate license key",
      "renewals-view": "Renew licenses",
      "account-view": "My Account",
    };
    const pageTitle = pageTitles[viewId] || "License Admin";
    document.getElementById("app-page-title").textContent = pageTitle;
    document.title = `${pageTitle} | dFb Chrome App`;
    const activeTab = ["generate-view", "renewals-view", "account-view"].includes(viewId) ? "more-view" : viewId;
    document.querySelectorAll(".admin-nav-item").forEach((item) => {
      const active = item.dataset.adminView === activeTab;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  const pullRefreshIndicator = document.getElementById("pull-refresh-indicator");
  const pullRefreshLabel = document.getElementById("pull-refresh-label");
  const refreshSkeleton = document.getElementById("refresh-skeleton");

  function resetPullRefresh() {
    pullStartY = null;
    pullDistance = 0;
    pullRefreshIndicator.hidden = true;
    pullRefreshIndicator.dataset.state = "";
    pullRefreshIndicator.style.height = "0px";
    pullRefreshLabel.textContent = "Pull to refresh";
  }

  function updatePullRefresh(distance) {
    pullDistance = Math.min(76, distance * 0.52);
    pullRefreshIndicator.hidden = false;
    pullRefreshIndicator.style.height = `${pullDistance}px`;
    const ready = pullDistance >= 58;
    pullRefreshIndicator.dataset.state = ready ? "ready" : "pulling";
    pullRefreshLabel.textContent = ready ? "Release to refresh" : "Pull to refresh";
  }

  async function completePullRefresh() {
    if (pullRefreshing || pullDistance < 58 || busy) {
      resetPullRefresh();
      return;
    }
    pullRefreshing = true;
    pullRefreshIndicator.hidden = false;
    pullRefreshIndicator.dataset.state = "refreshing";
    pullRefreshIndicator.style.height = "48px";
    pullRefreshLabel.textContent = "Refreshing…";
    try {
      await loadAdminData({ showOverlay: false, showSkeleton: true });
    } finally {
      pullRefreshing = false;
      resetPullRefresh();
    }
  }

  function renderDashboard() {
    const activeDeviceCount = licenses
      .filter(licenseIsUsable)
      .reduce((total, license) => total + (Array.isArray(license.devices) ? license.devices.length : 0), 0);
    const expiring = expiringLicenses();
    document.getElementById("dashboard-license-count").textContent = String(licenses.length);
    document.getElementById("dashboard-device-count").textContent = String(activeDeviceCount);
    document.getElementById("dashboard-expiring-count").textContent = String(expiring.length);
    renderActivityChart();
    const container = document.getElementById("dashboard-expiring-list");
    container.replaceChildren();
    if (!expiring.length) {
      container.append(makeElement("div", "empty-record", "No licenses are due to expire in the next 7 days."));
      return;
    }
    for (const license of expiring) {
      container.append(makeRenewalCard(license));
    }
  }

  function renderActivityChart() {
    const container = document.getElementById("activity-chart");
    const svgNamespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("viewBox", "0 0 360 170");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      const nextDate = new Date(date);
      nextDate.setDate(date.getDate() + 1);
      return {
        date,
        issued: licenses.filter((item) => {
          const createdAt = new Date(item.created_at).getTime();
          return Number.isFinite(createdAt) && createdAt >= date.getTime() && createdAt < nextDate.getTime();
        }).length,
      };
    });
    const maximum = Math.max(1, ...days.map((day) => day.issued));
    const plotTop = 12;
    const plotBottom = 132;
    const plotHeight = plotBottom - plotTop;
    for (let index = 0; index <= 3; index += 1) {
      const y = plotTop + (plotHeight / 3) * index;
      const line = document.createElementNS(svgNamespace, "line");
      line.setAttribute("x1", "8");
      line.setAttribute("x2", "354");
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", "#edf0f5");
      line.setAttribute("stroke-width", "1");
      svg.append(line);
    }

    days.forEach((day, index) => {
      const center = 32 + index * 49;
      const height = day.issued === 0 ? 3 : Math.max(5, (day.issued / maximum) * plotHeight);
      const bar = document.createElementNS(svgNamespace, "rect");
      bar.setAttribute("x", String(center - 6));
      bar.setAttribute("y", String(plotBottom - height));
      bar.setAttribute("width", "12");
      bar.setAttribute("height", String(height));
      bar.setAttribute("rx", "4");
      bar.setAttribute("fill", "#286fe8");
      svg.append(bar);
      const label = document.createElementNS(svgNamespace, "text");
      label.setAttribute("x", String(center));
      label.setAttribute("y", "154");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("fill", "#8792a2");
      label.setAttribute("font-size", "9");
      label.textContent = day.date.toLocaleDateString(undefined, { weekday: "short" });
      svg.append(label);
    });
    container.replaceChildren(svg);
  }

  function makeRenewButton(license) {
    const hasExpiry = Boolean(license.expires_at);
    return makeActionButton(hasExpiry ? "Renew license" : "Set expiry", "button-primary", () => {
      renewalLicenseId = license.id;
      const title = document.getElementById("renew-license-title");
      const description = document.getElementById("renew-license-description");
      title.textContent = hasExpiry ? "Renew license" : "Set license expiry";
      description.textContent = hasExpiry
        ? "The renewal term is added to the later of today or the current expiry date."
        : "Choose a term to set an expiry for this license, which currently has no expiry.";
      renewalDialog.showModal();
    });
  }

  function makeRenewalCard(license) {
    const card = makeElement("article", "record-card renewal-record");
    const header = makeElement("div", "record-heading");
    const expiryTime = new Date(license.expires_at).getTime();
    const expired = expiryTime <= Date.now();
    header.append(
      makeElement("strong", "", `${license.plan_type === "free" ? "Free" : "Paid"} · ${license.device_limit}-device license`),
      makeElement("span", `status-badge ${expired ? "inactive" : "active"}`, expired ? "expired" : "expiring soon"),
    );
    card.append(
      header,
      makeElement("code", "record-device-id", license.id),
      makeElement("p", "record-meta", `Expires ${formatDate(license.expires_at)} · ${Array.isArray(license.devices) ? license.devices.length : 0}/${license.device_limit} devices`),
    );
    if (license.request_contact) {
      card.append(makeElement("p", "record-meta", `Issued for ${license.request_contact.name} · ${license.request_contact.email}`));
    }
    card.append(makeRenewButton(license));
    return card;
  }

  function renderRenewals() {
    const expiring = expiringLicenses(true).sort(
      (left, right) => new Date(left.expires_at).getTime() - new Date(right.expires_at).getTime(),
    );
    const moreCount = document.getElementById("more-expiring-count");
    moreCount.textContent = String(expiring.length);
    moreCount.hidden = expiring.length === 0;
    const container = document.getElementById("renewal-list");
    container.replaceChildren();
    if (!expiring.length) {
      container.append(makeElement("div", "empty-record", "No expired or soon-to-expire licenses."));
      return;
    }
    for (const license of expiring) {
      container.append(makeRenewalCard(license));
    }
  }

  function renderActiveDevices() {
    const container = document.getElementById("active-device-list");
    container.replaceChildren();
    allActiveDeviceRecords = licenses
      .filter(licenseIsUsable)
      .flatMap((license) => (Array.isArray(license.devices) ? license.devices.map((device) => ({ license, device })) : []));
    updateSearchClearButton(document.getElementById("active-device-search"));
    filterActiveDevices(document.getElementById("active-device-search").value);
  }

  function updateSearchClearButton(input) {
    const clearButton = document.querySelector(`[data-clear-search="${input.id}"]`);
    if (clearButton) clearButton.hidden = input.value.length === 0;
  }

  document.getElementById("active-device-search").addEventListener("input", (event) => {
    const input = event.currentTarget;
    updateSearchClearButton(input);
    filterActiveDevices(input.value);
  });

  document.getElementById("license-search").addEventListener("input", (event) => {
    const input = event.currentTarget;
    updateSearchClearButton(input);
    renderLicenses(input.value);
  });

  document.querySelectorAll("[data-clear-search]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.clearSearch);
      if (!(input instanceof HTMLInputElement)) return;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const trigger = target?.closest(".active-device-menu-trigger");
    if (trigger) {
      const card = trigger.closest(".active-device-card");
      const menu = card?.querySelector(".active-device-menu");
      if (!menu) return;
      const shouldOpen = menu.hidden;
      document.querySelectorAll(".active-device-menu:not([hidden])").forEach((openMenu) => {
        openMenu.hidden = true;
        openMenu.closest(".active-device-card")
          ?.querySelector(".active-device-menu-trigger")
          ?.setAttribute("aria-expanded", "false");
      });
      menu.hidden = !shouldOpen;
      trigger.setAttribute("aria-expanded", String(shouldOpen));
      return;
    }

    if (target?.closest(".active-device-menu")) return;
    document.querySelectorAll(".active-device-menu:not([hidden])").forEach((openMenu) => {
      openMenu.hidden = true;
      openMenu.closest(".active-device-card")
        ?.querySelector(".active-device-menu-trigger")
        ?.setAttribute("aria-expanded", "false");
    });
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const trigger = target?.closest(".active-device-menu-trigger");
    if (trigger && event.key === "ArrowDown") {
      event.preventDefault();
      const menu = trigger.closest(".active-device-card")?.querySelector(".active-device-menu");
      if (menu) {
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        menu.querySelector('[role="menuitem"]')?.focus();
      }
      return;
    }

    const menu = target?.closest(".active-device-menu");
    if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      const currentIndex = items.indexOf(target);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items[nextIndex]?.focus();
      return;
    }

    if (event.key !== "Escape") return;
    const openMenu = document.querySelector(".active-device-menu:not([hidden])");
    if (!openMenu) return;
    openMenu.hidden = true;
    const focusTrigger = openMenu.closest(".active-device-card")?.querySelector(".active-device-menu-trigger");
    focusTrigger?.setAttribute("aria-expanded", "false");
    focusTrigger?.focus();
  });

  function filterActiveDevices(query) {
    const container = document.getElementById("active-device-list");
    const normalizedQuery = query.trim().toLocaleLowerCase();
    activeDeviceRecords = allActiveDeviceRecords.filter(({ license, device }) => {
      if (!normalizedQuery) return true;
      const customerValues = getCustomerInfo(license).map(([, value]) => value);
      const searchable = [
        device.device_id,
        license.id,
        license.license_key,
        license.plan_type,
        license.request_contact?.name,
        license.request_contact?.email,
        ...customerValues,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    });
    document.getElementById("active-device-search-status").textContent =
      `${activeDeviceRecords.length} ${activeDeviceRecords.length === 1 ? "device" : "devices"}${normalizedQuery ? " found" : ""}`;
    container.replaceChildren();
    activeDeviceRenderedCount = 0;
    const pagination = document.getElementById("active-device-pagination");
    pagination.hidden = true;
    if (!activeDeviceRecords.length) {
      const message = normalizedQuery
        ? "No active devices match your search."
        : "No active device activations.";
      container.append(makeElement("div", "empty-record", message));
      return;
    }
    appendActiveDevicePage();
    if (activeDeviceRecords.length > activeDevicePageSize) {
      pagination.hidden = false;
      updateActiveDevicePagination();
      observeActiveDevicePagination();
    }
  }

  function appendActiveDevicePage() {
    const container = document.getElementById("active-device-list");
    const end = Math.min(activeDeviceRenderedCount + activeDevicePageSize, activeDeviceRecords.length);
    for (const { license, device } of activeDeviceRecords.slice(activeDeviceRenderedCount, end)) {
      const card = makeElement("article", "active-device-card");
      const top = makeElement("div", "active-device-card-top");
      const heading = makeElement("div", "active-device-heading");
      const deviceIcon = makeElement("span", "active-device-icon", "▣");
      deviceIcon.setAttribute("aria-hidden", "true");
      const title = makeElement("div", "active-device-title");
      const customer = getCustomerInfo(license);
      const customerName = customer.find(([label]) => label === "Name")?.[1];
      const customerContact = customer
        .filter(([label]) => label !== "Name")
        .map(([, value]) => value)
        .join(" · ");
      title.append(
        makeElement("strong", "", customerName || `${license.plan_type === "free" ? "Free" : "Paid"} · ${license.device_limit}-device plan`),
        makeElement("span", "", customerContact
          || `${license.plan_type === "free" ? "Free" : "Paid"} · Activated ${formatDate(device.activated_at)}`),
      );
      heading.append(deviceIcon, title, makeElement("span", "active-device-status", "Active"));
      top.append(heading);

      const idPanel = makeElement("div", "active-device-id-panel");
      idPanel.append(
        makeElement("code", "active-device-id", device.device_id),
      );
      idPanel.title = device.device_id;

      const details = makeElement("div", "active-device-details");
      const verified = makeElement("div", "active-device-detail");
      verified.append(
        makeElement("span", "detail-label", "VERIFIED"),
        makeElement("strong", "", formatDate(device.last_verified_at)),
      );
      const expiry = makeElement("div", "active-device-detail");
      expiry.append(
        makeElement("span", "detail-label", "EXPIRES"),
        makeElement("strong", "", formatDate(license.expires_at)),
      );
      details.append(verified, expiry);

      const menuContainer = makeElement("div", "active-device-menu-container");
      const menuTrigger = makeElement("button", "active-device-menu-trigger", "⋯");
      menuTrigger.type = "button";
      menuTrigger.setAttribute("aria-label", `Actions for device ${device.device_id}`);
      menuTrigger.setAttribute("aria-haspopup", "menu");
      menuTrigger.setAttribute("aria-expanded", "false");
      const menu = makeElement("div", "active-device-menu");
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Device actions");
      menu.hidden = true;
      const makeMenuItem = (label, className, onClick) => {
        const button = makeActionButton(label, className, () => {
          menu.hidden = true;
          menuTrigger.setAttribute("aria-expanded", "false");
          onClick();
        });
        button.setAttribute("role", "menuitem");
        button.classList.add("active-device-menu-item");
        return button;
      };

      const viewLicenseButton = makeMenuItem("View license", "", () => {
        showAdminView("licenses-view");
        requestAnimationFrame(() => {
          const licenseCard = document.getElementById(`license-card-${license.id}`);
          licenseCard?.scrollIntoView({ behavior: "smooth", block: "start" });
          licenseCard?.classList.add("is-highlighted");
          window.setTimeout(() => licenseCard?.classList.remove("is-highlighted"), 1500);
        });
      });
      const renewButton = makeRenewButton(license);
      renewButton.setAttribute("role", "menuitem");
      renewButton.classList.add("active-device-menu-item");
      renewButton.addEventListener("click", () => {
        menu.hidden = true;
        menuTrigger.setAttribute("aria-expanded", "false");
      });
      const revokeButton = makeMenuItem("Revoke device", "button-danger-outline active-device-revoke", async () => {
        const confirmed = await showConfirm(
          "Revoke this device activation?",
          "The desktop app will be blocked the next time it verifies online.",
          device.device_id,
          "Revoke device",
        );
        if (!confirmed) return;
        const result = await runAdminAction({
          action: "admin_revoke_device",
          license_id: license.id,
          device_id: device.device_id,
        });
        if (result) await loadAdminData();
      });
      const separator = makeElement("div", "active-device-menu-separator");
      separator.setAttribute("role", "separator");
      menu.append(viewLicenseButton, renewButton, separator, revokeButton);
      menuContainer.append(menuTrigger, menu);
      top.append(menuContainer);
      card.append(top, idPanel, details);
      container.append(card);
    }
    activeDeviceRenderedCount = end;
    updateActiveDevicePagination();
  }

  function updateActiveDevicePagination() {
    const pagination = document.getElementById("active-device-pagination");
    const loadMoreButton = document.getElementById("active-device-load-more");
    const pageStatus = document.getElementById("active-device-page-status");
    const hasMore = activeDeviceRenderedCount < activeDeviceRecords.length;
    pagination.hidden = activeDeviceRecords.length <= activeDevicePageSize;
    loadMoreButton.hidden = !hasMore;
    pageStatus.textContent = `Showing ${activeDeviceRenderedCount} of ${activeDeviceRecords.length} active devices`;
  }

  function observeActiveDevicePagination() {
    const loadMoreButton = document.getElementById("active-device-load-more");
    if (!("IntersectionObserver" in window)) return;
    if (!activeDeviceObserver) {
      activeDeviceObserver = new IntersectionObserver((entries) => {
        const visible = document.getElementById("active-devices-view").hidden === false;
        if (visible && entries.some((entry) => entry.isIntersecting)) {
          appendActiveDevicePage();
        }
      }, { root: dashboard, rootMargin: "220px 0px" });
    }
    activeDeviceObserver.disconnect();
    activeDeviceObserver.observe(loadMoreButton);
  }

  function renderLicenses(query = document.getElementById("license-search").value) {
    const container = document.getElementById("license-list");
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchingLicenses = licenses.filter((license) => {
      if (!normalizedQuery) return true;
      const customerValues = getCustomerInfo(license).map(([, value]) => value);
      const status = !license.is_active
        ? "inactive disabled"
        : license.expires_at && new Date(license.expires_at).getTime() <= Date.now()
          ? "expired"
          : "active";
      const searchable = [
        license.id,
        license.license_key,
        license.plan_type,
        status,
        license.device_limit,
        license.expires_at,
        license.created_at,
        license.request_contact?.name,
        license.request_contact?.email,
        ...customerValues,
        ...(Array.isArray(license.devices) ? license.devices.map((device) => device.device_id) : []),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    });
    updateSearchClearButton(document.getElementById("license-search"));
    document.getElementById("license-search-status").textContent =
      `${matchingLicenses.length} ${matchingLicenses.length === 1 ? "license" : "licenses"}${normalizedQuery ? " found" : ""}`;
    container.replaceChildren();
    if (!matchingLicenses.length) {
      container.append(makeElement(
        "div",
        "empty-record",
        normalizedQuery ? "No licenses match your search." : "No licenses have been issued.",
      ));
      return;
    }

    for (const license of matchingLicenses) {
      const card = makeElement("article", "record-card license-record");
      card.id = `license-card-${license.id}`;
      const header = makeElement("div", "license-card-header");
      const expired = license.expires_at && new Date(license.expires_at).getTime() <= Date.now();
      const licenseStatus = !license.is_active ? "inactive" : expired ? "expired" : "active";
      const titleBlock = makeElement("div", "license-card-title");
      const licenseIcon = makeElement("span", "license-card-icon", "▤");
      licenseIcon.setAttribute("aria-hidden", "true");
      const titleCopy = makeElement("div", "license-card-title-copy");
      const planType = license.plan_type === "free" ? "Free" : "Paid";
      const customerInfo = getCustomerInfo(license);
      const customerName = customerInfo.find(([label]) => label === "Name")?.[1];
      titleCopy.append(
        makeElement("strong", "", customerName || `${planType} plan`),
        makeElement("span", "", customerName
          ? `${planType} · ${license.device_limit} device${Number(license.device_limit) === 1 ? "" : "s"}`
          : `${license.device_limit} device${Number(license.device_limit) === 1 ? "" : "s"} allowed`),
      );
      titleBlock.append(licenseIcon, titleCopy);
      header.append(titleBlock, makeElement("span", `status-badge license-status ${licenseStatus}`, licenseStatus));
      const menuTrigger = makeElement("button", "license-menu-trigger", "⋯");
      menuTrigger.type = "button";
      menuTrigger.setAttribute("aria-label", `Actions for ${customerName || planType + " license"}`);
      menuTrigger.setAttribute("aria-haspopup", "menu");
      menuTrigger.setAttribute("aria-expanded", "false");
      header.append(menuTrigger);
      const actionsMenu = makeElement("div", "license-actions-menu");
      actionsMenu.setAttribute("role", "menu");
      actionsMenu.hidden = true;
      let closeActionsMenu = () => {};
      const createLicenseDialog = (dialogClass, headingLabel, headingId) => {
        const dialog = makeElement("dialog", `license-details-dialog ${dialogClass}`);
        dialog.setAttribute("aria-labelledby", headingId);
        const panel = makeElement("div", "license-details-panel");
        const content = makeElement("div", "license-details-content");
        const dialogHeader = makeElement("div", "license-actions-header");
        const heading = makeElement("div", "license-actions-heading");
        heading.append(
          makeElement("span", "detail-label", headingLabel),
          makeElement("strong", "", customerName || `${planType} license`),
        );
        heading.lastElementChild.id = headingId;
        const closeButton = makeElement("button", "license-actions-close", "×");
        closeButton.type = "button";
        closeButton.setAttribute("aria-label", `Close ${headingLabel.toLowerCase()}`);
        closeButton.addEventListener("click", () => dialog.close());
        dialogHeader.append(heading, closeButton);
        panel.append(dialogHeader, content);
        dialog.append(panel);
        dialog.addEventListener("close", () => {
          if (menuTrigger.isConnected) menuTrigger.focus();
        });
        return { dialog, content };
      };
      const viewDialog = createLicenseDialog("license-view-dialog", "LICENSE OVERVIEW", `license-view-title-${license.id}`);
      const settingsDialog = createLicenseDialog("license-settings-dialog", "EDIT LICENSE SETTINGS", `license-settings-title-${license.id}`);
      const devicesDialog = createLicenseDialog("license-devices-dialog", "ACTIVATED DEVICES", `license-devices-title-${license.id}`);
      card.append(viewDialog.dialog, settingsDialog.dialog, devicesDialog.dialog, actionsMenu);
      const closeMenuOnOutsideClick = (event) => {
        if (!card.contains(event.target)) closeActionsMenu();
      };
      const closeMenuOnEscape = (event) => {
        if (event.key === "Escape" && !actionsMenu.hidden) {
          closeActionsMenu();
          menuTrigger.focus();
        }
      };
      closeActionsMenu = () => {
        if (actionsMenu.hidden) return;
        actionsMenu.hidden = true;
        menuTrigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", closeMenuOnOutsideClick);
        document.removeEventListener("keydown", closeMenuOnEscape);
      };
      menuTrigger.addEventListener("click", () => {
        if (!actionsMenu.hidden) {
          closeActionsMenu();
          return;
        }
        actionsMenu.hidden = false;
        menuTrigger.setAttribute("aria-expanded", "true");
        document.addEventListener("pointerdown", closeMenuOnOutsideClick);
        document.addEventListener("keydown", closeMenuOnEscape);
        actionsMenu.querySelector("button")?.focus();
      });
      const deviceCount = Array.isArray(license.devices) ? license.devices.length : 0;
      const devices = Array.isArray(license.devices) ? license.devices : [];
      const summary = makeElement("div", "license-summary-grid");
      const activeSummary = makeElement("div", "license-summary-item");
      activeSummary.append(
        makeElement("span", "detail-label", "ACTIVATED"),
        makeElement("strong", "", `${deviceCount} / ${license.device_limit}`),
      );
      const expirySummary = makeElement("div", "license-summary-item");
      expirySummary.append(
        makeElement("span", "detail-label", "EXPIRES"),
        makeElement("strong", "", formatDate(license.expires_at)),
      );
      const createdSummary = makeElement("div", "license-summary-item");
      createdSummary.append(
        makeElement("span", "detail-label", "CREATED"),
        makeElement("strong", "", formatDate(license.created_at)),
      );
      summary.append(activeSummary, expirySummary, createdSummary);
      viewDialog.content.append(summary.cloneNode(true));
      const overviewSection = makeElement("section", "license-overview-section");
      overviewSection.append(makeElement("strong", "license-overview-heading", "License information"));
      const overviewGrid = makeElement("div", "license-overview-grid");
      for (const [label, value] of [
        ["Status", licenseStatus],
        ["Plan", planType],
        ["Device limit", `${license.device_limit} device${Number(license.device_limit) === 1 ? "" : "s"}`],
      ]) {
        const item = makeElement("div", "license-overview-item");
        item.append(makeElement("span", "", label), makeElement("strong", "", value));
        overviewGrid.append(item);
      }
      overviewSection.append(overviewGrid);
      viewDialog.content.append(overviewSection);
      const keyPanel = makeElement("div", "license-key-panel");
      const keyHeading = makeElement("div", "license-key-heading");
      keyHeading.append(
        makeElement("strong", "", "License key"),
        makeElement("span", "license-key-secure-label", "Admin only"),
      );
      viewDialog.content.prepend(keyPanel);
      const keyRow = makeElement("div", "license-key-row");
      const keyValue = makeElement(
        "code",
        `license-key-value${license.license_key ? "" : " is-unavailable"}`,
        license.license_key || "Unavailable for licenses issued before key storage",
      );
      const keyCopy = makeElement("button", "key-copy-button", "Copy");
      keyCopy.type = "button";
      keyCopy.disabled = !license.license_key;
      keyCopy.setAttribute("aria-label", "Copy license key");
      const keyStatus = makeElement("span", "license-key-copy-status");
      keyStatus.setAttribute("role", "status");
      keyStatus.setAttribute("aria-live", "polite");
      if (license.license_key) {
        keyCopy.addEventListener("click", async () => {
          try {
            await copyTextToClipboard(license.license_key);
            keyStatus.textContent = "License key copied. Send it to the customer.";
          } catch (error) {
            keyStatus.textContent = `Could not copy license key: ${error?.message || error}`;
          }
        });
      }
      keyRow.append(keyValue, keyCopy);
      keyPanel.append(keyHeading, keyRow, keyStatus);
      card.append(header, summary);
      if (customerInfo.length) {
        const customer = makeElement("div", "license-customer");
        customer.append(makeElement("span", "license-customer-heading", "Customer information"));
        for (const [label, value] of customerInfo) {
          const item = makeElement("div", "license-customer-field");
          item.append(makeElement("span", "", label), makeElement("strong", "", value));
          customer.append(item);
        }
        viewDialog.content.append(customer);
      }
      const deviceOverview = makeElement("section", "license-overview-section license-overview-devices");
      const deviceOverviewHeading = makeElement("strong", "license-overview-heading", `Activated devices (${devices.length})`);
      deviceOverview.append(deviceOverviewHeading);
      if (!devices.length) {
        deviceOverview.append(makeElement("p", "empty-device-note", "No devices activated."));
      } else {
        const overviewDeviceList = makeElement("div", "admin-device-list");
        for (const device of devices) {
          const item = makeElement("div", "license-overview-device");
          item.append(
            makeElement("code", "record-device-id", device.device_id),
            makeElement("span", "record-meta", `Activated ${formatDate(device.activated_at)} · Verified ${formatDate(device.last_verified_at)}`),
          );
          overviewDeviceList.append(item);
        }
        deviceOverview.append(overviewDeviceList);
      }
      viewDialog.content.append(deviceOverview);

      const settingsSection = makeElement("section", "license-settings-section");
      const settingsHeading = makeElement("div", "license-section-heading");
      settingsHeading.append(
        makeElement("strong", "", "License settings"),
        makeElement("span", "", "Update status, device limit, or expiry"),
      );
      const settings = makeElement("div", "license-settings");
      const statusSelect = document.createElement("select");
      statusSelect.className = "compact-select";
      for (const [value, label] of [["true", "Active"], ["false", "Disabled"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = String(Boolean(license.is_active)) === value;
        statusSelect.append(option);
      }
      const statusControl = makeSelectControl(statusSelect);
      const limitControl = makeLimitSelect(license.device_limit);
      const expiryControl = makeDateInput(license.expires_at);
      const originalSettings = {
        status: statusControl.select.value,
        deviceLimit: limitControl.select.value,
        expiresAt: expiryControl.input.value,
      };
      settingsDialog.dialog.addEventListener("close", () => {
        statusControl.select.value = originalSettings.status;
        statusControl.select.dispatchEvent(new Event("change", { bubbles: true }));
        limitControl.select.value = originalSettings.deviceLimit;
        limitControl.select.dispatchEvent(new Event("change", { bubbles: true }));
        expiryControl.input.value = originalSettings.expiresAt;
        expiryControl.input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const statusField = makeElement("label", "license-setting-field");
      statusField.append(makeElement("span", "", "Status"), statusControl.element);
      const limitField = makeElement("label", "license-setting-field");
      limitField.append(makeElement("span", "", "Device limit"), limitControl.element);
      const expiryField = makeElement("label", "license-setting-field");
      expiryField.append(makeElement("span", "", "Expiry date"), expiryControl.element);
      const saveButton = makeActionButton("Save license settings", "button-primary", async () => {
        const expiresAt = expiryControl.input.value
          ? new Date(`${expiryControl.input.value}T23:59:59Z`).toISOString()
          : null;
        const result = await runAdminAction({
          action: "admin_set_license",
          license_id: license.id,
          is_active: statusControl.select.value === "true",
          device_limit: Number(limitControl.select.value),
          expires_at: expiresAt,
        });
        if (result) await loadAdminData();
      });
      saveButton.classList.add("license-save-button");
      settings.append(statusField, limitField, expiryField);
      settingsSection.append(settingsHeading, settings, saveButton);

      const deviceSection = makeElement("section", "license-devices-section");
      const deviceHeading = makeElement("div", "license-section-heading");
      deviceHeading.append(
        makeElement("strong", "", "Activated devices"),
        makeElement("span", "license-device-count", `${devices.length} of ${license.device_limit} used`),
      );
      deviceSection.append(deviceHeading);
      if (!devices.length) {
        deviceSection.append(makeElement("p", "empty-device-note", "No devices activated."));
      } else {
        const deviceList = makeElement("div", "admin-device-list");
        for (const device of devices) {
          const row = makeElement("div", "admin-device-row");
          const detail = makeElement("div", "admin-device-detail");
          detail.append(
            makeElement("code", "record-device-id", device.device_id),
            makeElement("span", "record-meta", `Activated ${formatDate(device.activated_at)} · Verified ${formatDate(device.last_verified_at)}`),
          );
          const revokeButton = makeActionButton("Revoke", "button-danger-outline", async () => {
            const confirmed = await showConfirm(
              "Revoke this device activation?",
              "The desktop app will be blocked the next time it verifies online.",
              device.device_id,
              "Revoke device",
            );
            if (!confirmed) return;
            const result = await runAdminAction({
              action: "admin_revoke_device",
              license_id: license.id,
              device_id: device.device_id,
            });
            if (result) await loadAdminData();
          });
          revokeButton.classList.add("license-device-revoke");
          row.append(detail, revokeButton);
          deviceList.append(row);
        }
        deviceSection.append(deviceList);
      }
      settingsDialog.content.append(settingsSection);
      devicesDialog.content.append(deviceSection);
      const makeActionItem = (label, onClick) => {
        const button = makeActionButton(label, "license-action-item", () => {
          closeActionsMenu();
          onClick();
        });
        button.setAttribute("role", "menuitem");
        return button;
      };
      const makeSectionAction = (label, dialog) => {
        actionsMenu.append(makeActionItem(label, () => {
          dialog.showModal();
        }));
      };
      makeSectionAction("View license details", viewDialog.dialog);
      makeSectionAction("Edit license settings", settingsDialog.dialog);
      makeSectionAction("Manage activated devices", devicesDialog.dialog);
      const menuSeparator = makeElement("div", "license-menu-separator");
      menuSeparator.setAttribute("role", "separator");
      actionsMenu.append(menuSeparator);
      const renewButton = makeRenewButton(license);
      renewButton.classList.add("license-action-item", "license-action-renew");
      renewButton.setAttribute("role", "menuitem");
      renewButton.addEventListener("click", closeActionsMenu);
      actionsMenu.append(renewButton);
      container.append(card);
    }
  }

  function showIssuedKey(key, email = "") {
    document.getElementById("issued-key-value").textContent = key;
    document.getElementById("issued-key-message").textContent = email
      ? `Send this key to ${email}. This is the only time it will be shown.`
      : "Copy this key now. This is the only time it will be shown.";
    issuedKeyDialog.showModal();
  }

  function signOut(showMessage = true) {
    resetPullRefresh();
    accessToken = "";
    refreshToken = "";
    adminEmail = "";
    const storageError = clearRememberedSession();
    licenses = [];
    allActiveDeviceRecords = [];
    activeDeviceRecords = [];
    activeDeviceRenderedCount = 0;
    activeDeviceObserver?.disconnect();
    hasLoadedAdminData = false;
    dashboard.hidden = true;
    authScreen.hidden = false;
    document.body.classList.remove("is-admin-authenticated");
    document.getElementById("refresh-admin").hidden = true;
    document.getElementById("secure-label").lastChild.textContent = " Secure admin sign in";
    showAdminView("home-view");
    document.getElementById("active-device-search").value = "";
    document.getElementById("license-search").value = "";
    updateSearchClearButton(document.getElementById("active-device-search"));
    updateSearchClearButton(document.getElementById("license-search"));
    document.getElementById("active-device-search-status").textContent = "";
    document.getElementById("license-search-status").textContent = "";
    renderLicenses();
    document.getElementById("active-device-list").replaceChildren();
    document.getElementById("active-device-pagination").hidden = true;
    document.getElementById("renewal-list").replaceChildren();
    document.getElementById("dashboard-expiring-list").replaceChildren();
    document.getElementById("activity-chart").replaceChildren();
    document.getElementById("admin-password").value = "";
    if (showMessage) {
      setStatus(loginMessage, storageError || "Signed out. The remembered admin session was cleared.", storageError ? "error" : "success");
    }
  }

  async function restoreAdminSession() {
    if (!configReady()) {
      finishAuthSplash();
      return;
    }
    let rememberedSession;
    try {
      rememberedSession = JSON.parse(localStorage.getItem(rememberedSessionKey) || "null");
    } catch (error) {
      clearRememberedSession();
      setStatus(loginMessage, `Could not read the remembered admin session: ${error?.message || error}`, "error");
      finishAuthSplash();
      return;
    }
    if (typeof rememberedSession?.refresh_token !== "string" || !rememberedSession.refresh_token) {
      finishAuthSplash();
      return;
    }

    rememberLoginCheckbox.checked = true;
    document.getElementById("admin-email").value = rememberedSession.email || "";
    setBusy(true);
    setAuthSplashStep("session", "Restoring your secure admin session…");
    setStatus(loginMessage, "Restoring your admin session…");
    try {
      const session = await requestAuth("/auth/v1/token?grant_type=refresh_token", {
        refresh_token: rememberedSession.refresh_token,
      });
      const persistenceMessage = setAuthSession(session, rememberedSession.email || "");
      setAuthSplashStep("access", "Verifying administrator access…");
      setStatus(loginMessage, persistenceMessage || "Session restored. Checking administrator permissions…", persistenceMessage ? "error" : "success");
      setBusy(false);
      setAuthSplashStep("workspace", "Loading your license workspace…");
      await loadAdminData();
    } catch (error) {
      setBusy(false);
      if (error.status === 400 || error.status === 401) {
        signOut(false);
        setStatus(loginMessage, "Your saved admin session has expired. Please sign in again.", "error");
      } else {
        setStatus(loginMessage, `Could not restore your admin session. Check your connection and try again. ${error?.message || error}`, "error");
      }
    } finally {
      finishAuthSplash();
    }
  }

  document.querySelectorAll(".field-grid select, #renewal-term").forEach((select) => {
    const parent = select.parentElement;
    const control = makeSelectControl(select);
    parent.append(control.element);
  });
  const issueExpiryInput = document.getElementById("issue-expires");
  const issueExpiryField = issueExpiryInput.parentElement;
  issueExpiryField.append(makeDatePicker(issueExpiryInput));
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    document.querySelectorAll(".date-picker.is-open").forEach((control) => {
      if (target instanceof Node && !control.contains(target)) {
        const popup = control.querySelector(".date-picker-popup");
        const trigger = control.querySelector(".date-picker-trigger");
        popup.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        control.classList.remove("is-open");
      }
    });
  });

  document.getElementById("admin-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!configReady()) {
      setStatus(loginMessage, "Set the Supabase publishable/anon key in license-portal/config.js before admin sign-in.", "error");
      return;
    }
    setBusy(true);
    authSplash.hidden = false;
    document.body.classList.add("is-checking-auth");
    setAuthSplashStep("session", "Signing in securely…");
    setStatus(loginMessage, "Signing in…");
    try {
      const result = await requestAuth("/auth/v1/token?grant_type=password", {
        email: document.getElementById("admin-email").value.trim(),
        password: document.getElementById("admin-password").value,
      });

      setAuthSplashStep("access", "Validating administrator access…");
      const persistenceMessage = setAuthSession(result, document.getElementById("admin-email").value.trim());
      document.getElementById("admin-password").value = "";
      setStatus(loginMessage, persistenceMessage || "Signed in. Checking administrator permissions…", persistenceMessage ? "error" : "success");
      setAuthSplashStep("workspace", "Loading your license workspace…");
      setBusy(false);
      await loadAdminData();
    } catch (error) {
      setStatus(loginMessage, error.message, "error");
      setBusy(false);
    } finally {
      finishAuthSplash();
    }
  });

  rememberLoginCheckbox.addEventListener("change", () => {
    const message = persistRememberedSession();
    if (message) setStatus(loginMessage, message, "error");
    else if (rememberLoginCheckbox.checked) setStatus(loginMessage, "This admin session will be remembered on this device.", "success");
    else setStatus(loginMessage, "Remembered login cleared. You remain signed in until you sign out.", "success");
  });

  document.getElementById("admin-sign-out").addEventListener("click", () => signOut());
  document.getElementById("refresh-admin").addEventListener("click", loadAdminData);
  document.getElementById("active-device-load-more").addEventListener("click", appendActiveDevicePage);
  dashboard.addEventListener("touchstart", (event) => {
    if (busy || pullRefreshing || dashboard.scrollTop > 0 || event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("dialog[open]")) return;
    if (target?.closest("button, input, select, textarea, a, [role='button']")) return;
    pullStartY = event.touches[0].clientY;
  }, { passive: true });
  dashboard.addEventListener("touchmove", (event) => {
    if (pullStartY === null || event.touches.length !== 1 || dashboard.scrollTop > 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("dialog[open]")) {
      resetPullRefresh();
      return;
    }
    const delta = event.touches[0].clientY - pullStartY;
    if (delta <= 0) {
      resetPullRefresh();
      return;
    }
    if (delta > 5 && event.cancelable) event.preventDefault();
    updatePullRefresh(delta);
  }, { passive: false });
  dashboard.addEventListener("touchend", () => {
    if (pullStartY === null) return;
    pullStartY = null;
    void completePullRefresh();
  });
  dashboard.addEventListener("touchcancel", resetPullRefresh);
  document.querySelectorAll(".admin-nav-item").forEach((item) => {
    item.addEventListener("click", () => showAdminView(item.dataset.adminView));
  });
  document.querySelectorAll("[data-route-view]").forEach((item) => {
    item.addEventListener("click", () => showAdminView(item.dataset.routeView));
  });

  document.getElementById("manual-issue-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const expiresValue = document.getElementById("issue-expires").value;
    const customerInfo = {
      name: document.getElementById("issue-customer-name").value.trim(),
      email: document.getElementById("issue-customer-email").value.trim(),
      phone: document.getElementById("issue-customer-phone").value.trim(),
      telegram: document.getElementById("issue-customer-telegram").value.trim(),
    };
    const result = await runAdminAction({
      action: "admin_issue",
      request_id: null,
      plan_type: document.getElementById("issue-plan-type").value,
      device_limit: Number(document.getElementById("issue-device-limit").value),
      expires_at: expiresValue ? new Date(`${expiresValue}T23:59:59Z`).toISOString() : null,
      customer_info: customerInfo,
    });
    if (result?.license_key) {
      showIssuedKey(result.license_key);
      document.getElementById("issue-expires").value = "";
      for (const field of ["name", "email", "phone", "telegram"]) {
        document.getElementById(`issue-customer-${field}`).value = "";
      }
      await loadAdminData();
    }
  });

  document.getElementById("cancel-renew-license").addEventListener("click", () => {
    renewalLicenseId = "";
    renewalDialog.close();
  });
  document.getElementById("confirm-renew-license").addEventListener("click", async () => {
    const license = licenses.find((item) => item.id === renewalLicenseId);
    const days = Number(document.getElementById("renewal-term").value);
    if (!license || ![30, 90, 365].includes(days)) {
      setPortalMessage("Select a valid license and renewal term.", "error");
      return;
    }
    const currentExpiry = license.expires_at ? new Date(license.expires_at).getTime() : 0;
    const renewalStart = Math.max(Date.now(), Number.isNaN(currentExpiry) ? 0 : currentExpiry);
    const expiresAt = new Date(renewalStart + days * 24 * 60 * 60 * 1000).toISOString();
    const result = await runAdminAction({
      action: "admin_set_license",
      license_id: license.id,
      is_active: true,
      device_limit: Number(license.device_limit),
      expires_at: expiresAt,
    });
    if (result) {
      renewalLicenseId = "";
      renewalDialog.close();
      await loadAdminData();
      setPortalMessage(`License renewed until ${formatDate(expiresAt)}.`, "success");
    }
  });

  document.getElementById("copy-issued-key").addEventListener("click", async () => {
    const key = document.getElementById("issued-key-value").textContent;
    try {
      await copyTextToClipboard(key);
      document.getElementById("issued-key-message").textContent = "Copied. Send it to the customer now; it cannot be recovered later.";
    } catch (error) {
      document.getElementById("issued-key-message").textContent = `Clipboard access failed. Select and copy the displayed key manually before closing. ${error?.message || error}`;
    }
  });
  document.getElementById("close-issued-key").addEventListener("click", () => {
    document.getElementById("issued-key-value").textContent = "";
    issuedKeyDialog.close();
  });
  issuedKeyDialog.addEventListener("close", () => {
    document.getElementById("issued-key-value").textContent = "";
  });

  if (!configReady()) {
    setStatus(loginMessage, "Portal setup required: add the Supabase publishable/anon key to license-portal/config.js.", "error");
    finishAuthSplash();
  } else {
    void restoreAdminSession();
  }
})();
