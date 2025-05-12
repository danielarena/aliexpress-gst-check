// ==UserScript==
// @name         AliExpress GST Checker
// @namespace    http://tampermonkey.net/
// @version      0.7-batch
// @description  Requires popups. See how much you've been overcharged on 'gst' by aliexpress.
// @author       Daniel Arena (Modified by AI)
// @match        https://www.aliexpress.com/p/order/index.html*
// @match        https://www.aliexpress.com/p/order/detail.html*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=aliexpress.com
// @connect      aliexpress.com
// @grant        GM_openInTab
// @grant        GM_closeTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_log
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const GST_RATE = 0.10; // 10% GST
    // const GST_TOLERANCE = 0.02; // Tolerance for original discrepancy check (kept for reference, but new logic used)
    const BATCH_SIZE = 10; // Process 10 orders at a time
    const DELAY_BETWEEN_TAB_OPENS = 1000; // ms delay between opening each new tab within a batch
    const MAX_WAIT_FOR_ELEMENT = 15000; // ms max time to wait for elements on detail page
    const POLLING_INTERVAL = 3000; // ms interval for list page to check for results
    const DETAIL_PAGE_TIMEOUT_CHECK = 120000; // ms (2 minutes) after which list page assumes a detail tab failed

    // --- Selectors ---
    const ORDER_ITEM_SELECTOR = '.order-main .order-item'; // On list page
    const ORDER_ID_SELECTOR_PARENT = '.order-item-header-right-info'; // Parent of div containing Order ID on list page
    const ORDER_DETAIL_LINK_SELECTOR = 'a[href*="/p/order/detail.html"]'; // Link to detail page within order item
    const DROPDOWN_BUTTON_SELECTOR = 'span.comet-icon-arrowdown.switch-icon'; // ON DETAIL PAGE
    const PRICE_CONTAINER_SELECTOR = '.order-price'; // ON DETAIL PAGE - Container for all price rows
    const PRICE_ITEM_SELECTOR = '.order-price-item'; // ON DETAIL PAGE - Selector for individual price rows
    const PRICE_LABEL_SELECTOR = '.left-col'; // ON DETAIL PAGE - Selector for label (Subtotal, Tax) within a price row
    const PRICE_VALUE_SELECTOR = '.right-col'; // ON DETAIL PAGE - Selector for value within a price row
    const TEXT_TO_WAIT_FOR_AFTER_CLICK = 'Tax'; // ON DETAIL PAGE - Text content that appears *after* dropdown click

    // --- Global State (List Page) ---
    let pollerIntervalId = null;
    let checkStartTime = 0;
    let batchPendingOrderIds = []; // IDs pending for the *current batch*
    let allOrderData = []; // Array to hold {id: '...', url: '...'} for all orders found
    let currentBatchIndex = 0; // Index of the next batch to process
    let totalGstErrorValue = 0; // Running total of the GST error monetary value
    let isProcessing = false; // Flag to prevent multiple concurrent operations

    // Keeps track of overall progress across batches
    let sessionResults = {
        discrepancies: 0, // Count of orders meeting the *new* error criteria
        errors: 0,        // Count of processing errors/timeouts
        processed: 0,     // Total orders processed across all batches
        totalOrders: 0    // Total orders found on the page
    };

    // --- Styling & Logger ---
    GM_addStyle(`
        #gst-checker-main-button { /* Start Button */
            position: fixed; bottom: 20px; left: 20px; z-index: 10001; padding: 10px 15px;
            background-color: #ff8c00; color: white; border: none; border-radius: 5px;
            cursor: pointer; font-size: 14px; box-shadow: 2px 2px 5px rgba(0,0,0,0.2);
        }
        #gst-checker-main-button:hover { background-color: #cc7000; }
        #gst-checker-main-button:disabled { background-color: #cccccc; cursor: not-allowed; }

        #gst-checker-batch-button { /* Next Batch Button */
            position: fixed; bottom: 20px; left: 20px; z-index: 10001; padding: 10px 15px;
            background-color: #007bff; color: white; border: none; border-radius: 5px;
            cursor: pointer; font-size: 14px; box-shadow: 2px 2px 5px rgba(0,0,0,0.2);
            display: none; /* Initially hidden */
        }
        #gst-checker-batch-button:hover { background-color: #0056b3; }
        #gst-checker-batch-button:disabled { background-color: #cccccc; cursor: not-allowed; }

        #custom-logger-mt { /* Unique ID */
            position: fixed; bottom: 65px; left: 20px; width: 450px; max-height: 300px;
            overflow-y: scroll; background-color: #f8f8f8; border: 1px solid #aaa; padding: 8px;
            font-family: monospace; font-size: 11px; line-height: 1.3; color: #333;
            z-index: 10000; display: none; white-space: pre-wrap; box-shadow: 2px 2px 5px rgba(0,0,0,0.1);
        }
    `);
    let customLoggerDiv = null; // Shared logger div

    // --- Helper Functions ---
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function logToScreen(message, level = "INFO") {
        const timestamp = new Date().toLocaleTimeString();
        const logMessage = `[${timestamp}][${level}] ${message}`;
        GM_log(logMessage); // Tampermonkey log
        console.log(`[${level}] ${message}`); // Browser console log

        if (!customLoggerDiv) {
            customLoggerDiv = document.createElement('div');
            customLoggerDiv.id = 'custom-logger-mt';
            document.body.appendChild(customLoggerDiv);
        }
        customLoggerDiv.style.display = 'block';
        const logEntry = document.createElement('div');
        logEntry.textContent = logMessage;
         if (level === "ERROR") logEntry.style.color = 'red';
         if (level === "WARN") logEntry.style.color = 'orange';
        customLoggerDiv.appendChild(logEntry);
        customLoggerDiv.scrollTop = customLoggerDiv.scrollHeight;
    }

    function parsePrice(priceStr, contextLabel = "Price") {
        if (!priceStr || typeof priceStr !== 'string') return 0;
        const originalStr = priceStr.trim();
        // Handle currency symbols and potential extra text robustly
        if (originalStr.toLowerCase().includes('free shipping')) return 0;
        const cleanedStr = originalStr.replace(/[^0-9.,-]/g, '').replace(',', '.'); // Keep dots and hyphens, replace comma with dot
        // Handle potential multiple dots (e.g., 1.234.56 -> 1234.56) - find last dot
        const lastDotIndex = cleanedStr.lastIndexOf('.');
        let finalStr = cleanedStr;
        if (lastDotIndex !== -1) {
            finalStr = cleanedStr.substring(0, lastDotIndex).replace(/\./g, '') + cleanedStr.substring(lastDotIndex);
        }
        const price = parseFloat(finalStr);

        if (isNaN(price)) {
             logToScreen(`parsePrice [${contextLabel}] - NaN for "${originalStr}" -> "${cleanedStr}" -> "${finalStr}"`, "WARN");
             return 0;
        }
        return price;
    }

    function formatCurrency(value) {
        // Basic AUD formatting, adjust if needed
        return `AU$${value.toFixed(2)}`;
    }

    function waitForElement(selector, timeout = MAX_WAIT_FOR_ELEMENT) {
         return new Promise((resolve, reject) => {
             logToScreen(`Waiting for element: "${selector}" (Max ${timeout/1000}s)`);
             const startTime = Date.now();
             const interval = setInterval(() => {
                 const element = document.querySelector(selector);
                 if (element) {
                     clearInterval(interval);
                     logToScreen(`Element found: "${selector}"`);
                     resolve(element);
                 } else if (Date.now() - startTime > timeout) {
                     clearInterval(interval);
                     logToScreen(`Timeout waiting for element: "${selector}"`, "ERROR");
                     reject(new Error(`Timeout waiting for element: ${selector}`));
                 }
             }, 500); // Check every 500ms
         });
      }

    function waitForTextInElement(parentSelector, textToFind, timeout = MAX_WAIT_FOR_ELEMENT) {
         return new Promise((resolve, reject) => {
             logToScreen(`Waiting for text "${textToFind}" in "${parentSelector}" (Max ${timeout/1000}s)`);
             const startTime = Date.now();
             const lowerText = textToFind.toLowerCase();
             const interval = setInterval(() => {
                 const parentElement = document.querySelector(parentSelector);
                 // Check if parent exists and contains the text
                 if (parentElement && parentElement.textContent.toLowerCase().includes(lowerText)) {
                     clearInterval(interval);
                     logToScreen(`Text "${textToFind}" found in "${parentSelector}"`);
                     resolve();
                 } else if (Date.now() - startTime > timeout) {
                     clearInterval(interval);
                     logToScreen(`Timeout waiting for text "${textToFind}" in "${parentSelector}"`, "ERROR");
                     reject(new Error(`Timeout waiting for text: ${textToFind} in ${parentSelector}`));
                 }
             }, 500); // Check every 500ms
         });
     }

     /**
      * Finds a price item by its label text. Logs details minimally now.
      * @param {Element} priceContainer The container element holding all price items.
      * @param {string} labelText The text label to search for (case-insensitive).
      * @returns {number|null} The numeric price value or null if not found.
      */
     function findPriceByLabel(priceContainer, labelText) {
         // logToScreen(`DEBUG: findPriceByLabel - Searching for label "${labelText}"...`); // Reduced verbosity
         if (!priceContainer) return null;
         const items = priceContainer.querySelectorAll(PRICE_ITEM_SELECTOR);
         const lowerLabelText = labelText.toLowerCase().trim();
         for (const [index, item] of items.entries()) {
             const labelElem = item.querySelector(PRICE_LABEL_SELECTOR);
             const valueElem = item.querySelector(PRICE_VALUE_SELECTOR);
             if (labelElem) {
                 const currentLabelText = (labelElem.textContent || '').toLowerCase().trim();
                 if (currentLabelText.includes(lowerLabelText)) {
                     let priceText = '';
                     if (valueElem) {
                         priceText = (valueElem.innerText || valueElem.textContent || '').trim();
                         if (!priceText || priceText.length === 0 || priceText === 'AU$') {
                             const nestedPriceElem = valueElem.querySelector('div[class*="es--wrap"]'); // Common pattern
                             if (nestedPriceElem) priceText = (nestedPriceElem.textContent || '').trim();
                         }
                     }
                     const parsedVal = parsePrice(priceText, labelText);
                     logToScreen(`Found "${labelText}", Value: ${formatCurrency(parsedVal)} (Raw: "${priceText}")`, "DEBUG");
                     return parsedVal;
                 }
             }
         }
         logToScreen(`Label "${labelText}" not found.`, "WARN");
         return null;
     }

     /**
      * Calculates total discounts. Logs details minimally now.
      * @param {Element} priceContainer The container element.
      * @returns {number} The total absolute value of discounts.
      */
     function calculateTotalDiscounts(priceContainer) {
         let totalDiscount = 0;
         // logToScreen(`DEBUG: calculateTotalDiscounts - Calculating discounts...`); // Reduced verbosity
         if (!priceContainer) return 0;
         const items = priceContainer.querySelectorAll(PRICE_ITEM_SELECTOR);
         for (const [index, item] of items.entries()) {
             const valueElem = item.querySelector(PRICE_VALUE_SELECTOR);
             const labelElem = item.querySelector(PRICE_LABEL_SELECTOR);
             let priceText = '';
             let labelText = '';
             let isDiscount = false;
             if (labelElem) labelText = (labelElem.textContent || '').toLowerCase().trim();
             if (valueElem) {
                  priceText = (valueElem.innerText || valueElem.textContent || '').trim();
                  if (!priceText || priceText.length === 0 || priceText === 'AU$') {
                      const nestedPriceElem = valueElem.querySelector('div[class*="es--wrap"]');
                      if (nestedPriceElem) priceText = (nestedPriceElem.textContent || '').trim();
                  }
             }
             // Identify discount rows: Negative sign in value, or specific labels
             if (priceText.includes('-') || labelText.includes('coins') || labelText.includes('coupon') || labelText.includes('discount')) {
                 isDiscount = true;
             }

             if (isDiscount) {
                 const discountValue = parsePrice(priceText, `Discount (${labelText || 'Negative Value'})`);
                 const absDiscount = Math.abs(discountValue);
                 totalDiscount += absDiscount;
                 logToScreen(`Found discount "${labelText}", Value: ${formatCurrency(discountValue)}. Added ${formatCurrency(absDiscount)} to total. New total: ${formatCurrency(totalDiscount)}`, "DEBUG");
             }
         }
         logToScreen(`Total Discount Calculated: ${formatCurrency(totalDiscount)}`, "DEBUG");
         return totalDiscount;
     }


    // --- Core Logic ---

    /**
     * Logic executed ONLY on the order list page.
     */
    async function runListPageLogic() {
        logToScreen("Running List Page Logic");
        addControlButtons();
    }

    function addControlButtons() {
        if (document.getElementById('gst-checker-main-button') || document.getElementById('gst-checker-batch-button')) return;

        // Initial Start Button
        const startButton = document.createElement('button');
        startButton.id = 'gst-checker-main-button';
        startButton.textContent = 'Start GST Check (Batches)';
        startButton.addEventListener('click', initializeAndStartFirstBatch);
        document.body.appendChild(startButton);

        // Next Batch Button (initially hidden)
        const nextBatchButton = document.createElement('button');
        nextBatchButton.id = 'gst-checker-batch-button';
        nextBatchButton.textContent = 'Process Next Batch';
        nextBatchButton.addEventListener('click', processCurrentBatch);
        document.body.appendChild(nextBatchButton);

        logToScreen("Control buttons added.");
    }

    async function initializeAndStartFirstBatch() {
        const startButton = document.getElementById('gst-checker-main-button');
        const nextBatchButton = document.getElementById('gst-checker-batch-button');

        if (isProcessing) {
            logToScreen("Processing is already in progress.", "WARN");
            return;
        }
        isProcessing = true; // Set processing flag

        logToScreen("--- Initializing GST Check ---", "WARN");
        if(customLoggerDiv) customLoggerDiv.innerHTML = ''; // Clear logger on new run
        sessionResults = { discrepancies: 0, errors: 0, processed: 0, totalOrders: 0 }; // Reset results
        totalGstErrorValue = 0; // Reset total error value
        currentBatchIndex = 0; // Start from the first batch
        allOrderData = []; // Clear previous order list

        startButton.disabled = true;
        startButton.style.display = 'none'; // Hide start button
        nextBatchButton.style.display = 'block'; // Show batch button
        nextBatchButton.disabled = true; // Disable initially
        nextBatchButton.textContent = 'Initializing...';

        // Clear previous run storage
        logToScreen("Clearing previous results from storage...");
        const keys = await GM_listValues();
        for (const key of keys) {
            if (key.startsWith('gst_result_') || key.startsWith('gst_status_') || key === 'gst_batch_pending') {
                await GM_deleteValue(key);
            }
        }
        logToScreen("Previous storage cleared.");

        // Collect all orders on the page
        logToScreen(`Searching for orders using selector: "${ORDER_ITEM_SELECTOR}"`);
        const orderItems = document.querySelectorAll(ORDER_ITEM_SELECTOR);
        sessionResults.totalOrders = orderItems.length;

        if (sessionResults.totalOrders === 0) {
            logToScreen("No orders found. Check selector.", "ERROR");
            alert("No orders found. Check ORDER_ITEM_SELECTOR in script.");
            resetUIAndState(); // Reset UI
            return;
        }

        logToScreen(`Found ${sessionResults.totalOrders} orders total.`);

        for (const [index, item] of orderItems.entries()) {
            let orderId = `Unknown-${index + 1}`;
            let detailUrl = null;

            try {
                // Extract Order ID
                const parentInfo = item.querySelector(ORDER_ID_SELECTOR_PARENT);
                if (parentInfo) {
                     const infoDivs = parentInfo.querySelectorAll(':scope > div');
                     infoDivs.forEach(div => {
                         if (div.textContent && div.textContent.includes('Order ID:')) {
                             const match = div.textContent.match(/Order ID:\s*(\d+)/);
                             if (match && match[1]) orderId = match[1];
                         }
                     });
                }
                 // Extract Detail URL
                 const linkElem = item.querySelector(ORDER_DETAIL_LINK_SELECTOR);
                 if (linkElem && linkElem.href) {
                     detailUrl = linkElem.href;
                     // Ensure URL is absolute and clean
                     detailUrl = new URL(detailUrl, window.location.origin).href;
                     // If Order ID was unknown, try getting from URL
                     if (orderId.startsWith('Unknown-')) {
                         const urlParams = new URLSearchParams(new URL(detailUrl).search);
                         const idFromUrl = urlParams.get('orderId');
                         if (idFromUrl) orderId = idFromUrl;
                     }
                 }

            } catch (e) { logToScreen(`Failed to extract Order ID/URL for item ${index + 1}`, "WARN"); }

            if (orderId.startsWith('Unknown-') || !detailUrl) {
                logToScreen(`Cannot get Order ID (${orderId}) or Detail URL (${detailUrl}) for item ${index + 1}. Skipping.`, "ERROR");
                sessionResults.errors++; // Count as an error if we can't even process it
                continue;
            }
             allOrderData.push({ id: orderId, url: detailUrl });
        }

        logToScreen(`Successfully mapped ${allOrderData.length} orders for processing.`);
        sessionResults.totalOrders = allOrderData.length; // Update total based on successfully mapped ones

        if (allOrderData.length > 0) {
             // Start the first batch
            await processCurrentBatch();
        } else {
             logToScreen("No valid orders could be prepared for processing.", "ERROR");
             finalizeCheck(); // Go straight to finalize if nothing to process
        }
    }

    async function processCurrentBatch() {
        const nextBatchButton = document.getElementById('gst-checker-batch-button');
        nextBatchButton.disabled = true; // Disable while processing batch

        const startIndex = currentBatchIndex * BATCH_SIZE;
        const endIndex = Math.min(startIndex + BATCH_SIZE, allOrderData.length);

        if (startIndex >= allOrderData.length) {
            logToScreen("All batches processed. No more orders to process.", "INFO");
            nextBatchButton.textContent = 'All Orders Processed';
            nextBatchButton.disabled = true; // Keep disabled
            finalizeCheck(); // Run final summary
            return; // Exit function
        }

        const currentBatchOrders = allOrderData.slice(startIndex, endIndex);
        batchPendingOrderIds = []; // Reset pending list for this batch

        logToScreen(`--- Starting Batch ${currentBatchIndex + 1} (Orders ${startIndex + 1}-${endIndex} of ${allOrderData.length}) ---`, "INFO");
        nextBatchButton.textContent = `Processing Batch ${currentBatchIndex + 1}...`;

        if (currentBatchOrders.length === 0) {
             logToScreen(`Batch ${currentBatchIndex + 1} is empty. Moving to next.`, "WARN");
             currentBatchIndex++; // Move to the next index
             // We should theoretically not hit this if the initial check works, but just in case
             await processCurrentBatch(); // Try processing the *next* batch immediately
             return;
        }

        checkStartTime = Date.now(); // Reset start time for timeout checks for this batch

        for (const [batchIndex, order] of currentBatchOrders.entries()) {
            const overallIndex = startIndex + batchIndex;
            logToScreen(`(${overallIndex + 1}/${allOrderData.length}) Processing Order ${order.id}. Opening tab...`);
            batchPendingOrderIds.push(order.id);
            // Store status *before* opening tab
            await GM_setValue(`gst_status_${order.id}`, { status: "pending", openedAt: Date.now() });
            GM_openInTab(order.url, { active: false, setParent: true });

            if (batchIndex < currentBatchOrders.length - 1) {
                await sleep(DELAY_BETWEEN_TAB_OPENS);
            }
        }

        await GM_setValue('gst_batch_pending', JSON.stringify(batchPendingOrderIds));

        logToScreen(`Batch ${currentBatchIndex + 1}: ${batchPendingOrderIds.length} tabs opened (or attempted). Starting to poll for results...`);
        if (pollerIntervalId) clearInterval(pollerIntervalId); // Clear any previous interval
        pollerIntervalId = setInterval(checkBatchResults, POLLING_INTERVAL);
    }

    async function checkBatchResults() {
        let currentPendingIdsStr = await GM_getValue('gst_batch_pending', '[]');
        let currentPendingIds;
        try {
            currentPendingIds = JSON.parse(currentPendingIdsStr);
            if (!Array.isArray(currentPendingIds)) throw new Error("Not an array");
        } catch(e) {
            logToScreen(`Polling stopped: Corrupted pending list for batch ${currentBatchIndex + 1}. ${e.message}`, "ERROR");
            if(pollerIntervalId) clearInterval(pollerIntervalId);
            pollerIntervalId = null;
             // Assume batch failed, attempt to move to next? Or finalize with error?
             // Let's finalize with error state for safety.
             sessionResults.errors += (batchPendingOrderIds?.length || BATCH_SIZE); // Estimate errors
            finalizeCheck();
            return;
        }


        const batchTotalToCheck = batchPendingOrderIds.length; // Original count for this batch
        const processedThisPoll = sessionResults.processed; // Count before this poll cycle

        logToScreen(`Batch ${currentBatchIndex + 1} Polling... ${batchTotalToCheck - currentPendingIds.length}/${batchTotalToCheck} results received for this batch. ${currentPendingIds.length} pending.`);

        if (currentPendingIds.length === 0) {
            logToScreen(`Polling complete for Batch ${currentBatchIndex + 1}. All results accounted for.`, "INFO");
            if(pollerIntervalId) clearInterval(pollerIntervalId);
            pollerIntervalId = null;
            finishBatch(); // Handle end of batch logic
            return;
        }

        let stillPending = [];
        let madeProgressThisCycle = false;

        for (const orderId of currentPendingIds) {
            const result = await GM_getValue(`gst_result_${orderId}`, null);
            const statusInfo = await GM_getValue(`gst_status_${orderId}`, null);

            if (result) {
                madeProgressThisCycle = true;
                sessionResults.processed++; // Increment overall processed count

                logToScreen(`Result received for Order ${orderId}: Status=${result.status}`);
                if(result.status === 'error') {
                    sessionResults.errors++;
                    logToScreen(`  Error Message: ${result.message}`, "ERROR");
                } else if (result.status === 'success') {
                     // NEW ERROR CHECK LOGIC
                    if (result.isOverchargeError) {
                        sessionResults.discrepancies++;
                        totalGstErrorValue += result.monetaryDifference; // Add the calculated difference to total
                        logToScreen(`  GST Overcharge ERROR Found! Tax: ${formatCurrency(result.found)}, Subtotal Threshold: ${formatCurrency(result.subtotalThreshold)}. Diff: ${formatCurrency(result.monetaryDifference)}`, "ERROR");
                    } else {
                         logToScreen(`  GST OK (Tax: ${formatCurrency(result.found)} vs Subtotal Threshold: ${formatCurrency(result.subtotalThreshold)}) Diff from calculated base: ${formatCurrency(result.monetaryDifference)}`);
                    }
                }
                await GM_deleteValue(`gst_result_${orderId}`);
                await GM_deleteValue(`gst_status_${orderId}`);
            } else {
                // Check for timeout only if status exists
                if (statusInfo && statusInfo.openedAt && (Date.now() - statusInfo.openedAt > DETAIL_PAGE_TIMEOUT_CHECK)) {
                    madeProgressThisCycle = true;
                    sessionResults.processed++;
                    sessionResults.errors++;
                    logToScreen(`Order ${orderId} timed out (>${DETAIL_PAGE_TIMEOUT_CHECK/1000}s). Assuming failure.`, "ERROR");
                    await GM_deleteValue(`gst_status_${orderId}`); // Stop checking timeout
                } else {
                    // Only keep it in pending list if it hasn't timed out and no result received
                    stillPending.push(orderId);
                }
            }
        }

        // Update pending list in storage only if it changed
        if (madeProgressThisCycle || stillPending.length !== currentPendingIds.length) {
            await GM_setValue('gst_batch_pending', JSON.stringify(stillPending));
        }

        // Final check if the loop finished all pending items NOW
         if (stillPending.length === 0) {
             logToScreen(`Polling check: Batch ${currentBatchIndex + 1} pending list is now empty.`, "INFO");
             if(pollerIntervalId) clearInterval(pollerIntervalId);
             pollerIntervalId = null;
             finishBatch(); // Handle end of batch logic
         }
    }

    function finishBatch() {
        logToScreen(`--- Finished Batch ${currentBatchIndex + 1} ---`);
        currentBatchIndex++; // Increment batch index for the next run

        const nextBatchButton = document.getElementById('gst-checker-batch-button');
        const startIndex = currentBatchIndex * BATCH_SIZE;

        if (startIndex >= allOrderData.length) {
            // All batches are done
            logToScreen("All available batches have been processed.", "INFO");
            nextBatchButton.textContent = 'All Orders Processed';
            nextBatchButton.disabled = true; // Keep disabled
            finalizeCheck(); // Show final results
        } else {
            // More batches remain
            const remainingOrders = allOrderData.length - startIndex;
            const nextBatchSize = Math.min(BATCH_SIZE, remainingOrders);
            logToScreen(`Ready for next batch. Click button to process ${nextBatchSize} more orders.`, "INFO");
            nextBatchButton.textContent = `Process Next Batch (${nextBatchSize} Orders)`;
            nextBatchButton.disabled = false; // Enable for next click
        }
    }

     function finalizeCheck() {
        isProcessing = false; // Release processing flag
        if(pollerIntervalId) clearInterval(pollerIntervalId); // Ensure poller is stopped
        pollerIntervalId = null;

        const successCount = sessionResults.processed - sessionResults.errors;
        const totalAttempted = sessionResults.totalOrders; // Use the initially found count

        const message = `--- GST Check Complete ---
Total Orders Found: ${totalAttempted}
Total Orders Processed: ${sessionResults.processed}
Successfully Checked: ${successCount}
Processing Errors/Timeouts: ${sessionResults.errors}
Potential GST Overcharge Errors Found: ${sessionResults.discrepancies}
Total Monetary Value of Overcharge Errors: ${formatCurrency(totalGstErrorValue)}

Check log for details on specific orders.`;

        logToScreen(message, "INFO");
        alert(message.replace(/---/g, '').trim());

        // Keep the "Next Batch" button visible but potentially disabled
        const nextBatchButton = document.getElementById('gst-checker-batch-button');
        if (nextBatchButton) {
            if (currentBatchIndex * BATCH_SIZE >= allOrderData.length) {
                 nextBatchButton.textContent = 'All Orders Processed';
                 nextBatchButton.disabled = true;
            } else {
                 // This case might occur if finalized early due to error
                 nextBatchButton.textContent = 'Process Next Batch (Check Log)';
                 nextBatchButton.disabled = false; // Allow retry? Or keep disabled? Let's disable.
                 nextBatchButton.disabled = true;
                 logToScreen("Finalized check but more batches seemed available. Check logs for errors.", "WARN");
            }
            nextBatchButton.style.display = 'block'; // Ensure it's visible
        }

        const startButton = document.getElementById('gst-checker-main-button');
        if (startButton) {
            startButton.style.display = 'none'; // Keep start button hidden
        }
         // Optional: Clean up storage further?
         // GM_deleteValue('gst_batch_pending');
     }

     function resetUIAndState() {
         isProcessing = false;
         if (pollerIntervalId) clearInterval(pollerIntervalId);
         pollerIntervalId = null;

         const startButton = document.getElementById('gst-checker-main-button');
         const nextBatchButton = document.getElementById('gst-checker-batch-button');

         if (startButton) {
             startButton.disabled = false;
             startButton.textContent = 'Start GST Check (Batches)';
             startButton.style.display = 'block';
         }
         if (nextBatchButton) {
             nextBatchButton.style.display = 'none';
             nextBatchButton.disabled = false; // Reset state
         }

         allOrderData = [];
         currentBatchIndex = 0;
         totalGstErrorValue = 0;
         sessionResults = { discrepancies: 0, errors: 0, processed: 0, totalOrders: 0 };
         logToScreen("UI and state reset.", "INFO");
     }

    /**
     * Logic executed ONLY on the order detail page.
     */
    async function runDetailPageLogic() {
        logToScreen("Running Detail Page Logic");

        const urlParams = new URLSearchParams(window.location.search);
        const orderId = urlParams.get('orderId');
        if (!orderId) {
            logToScreen("Could not get Order ID from URL. Cannot report result.", "ERROR");
            await sleep(2000); GM_closeTab(); return;
        }
        logToScreen(`Detail page for Order ID: ${orderId}`);

        let resultData = {
            status: "error",
            message: "Unknown error",
            orderId: orderId,
            isOverchargeError: false,
            monetaryDifference: 0,
            found: 0,
            subtotalThreshold: 0
        };

        try {
            // 1. Wait for and click the dropdown button
            logToScreen(`Waiting for dropdown button: "${DROPDOWN_BUTTON_SELECTOR}"`);
            const dropdownButton = await waitForElement(DROPDOWN_BUTTON_SELECTOR);
            logToScreen(`Clicking dropdown button for Order ${orderId}...`);
             // Attempt scroll into view just in case
             dropdownButton.scrollIntoView({ behavior: "auto", block: "center" });
             await sleep(300); // Short pause after scroll
            dropdownButton.click();
            logToScreen(`Dropdown button clicked for Order ${orderId}.`);

            // 2. Wait for content revealed by the click (wait for 'Tax' text)
            await waitForTextInElement(PRICE_CONTAINER_SELECTOR, TEXT_TO_WAIT_FOR_AFTER_CLICK);
            logToScreen(`Content after click revealed ('${TEXT_TO_WAIT_FOR_AFTER_CLICK}' text found) for Order ${orderId}.`);
            await sleep(500); // Small delay for rendering stability

            // 3. Find the price container
            const priceContainer = document.querySelector(PRICE_CONTAINER_SELECTOR);
            if (!priceContainer) {
                throw new Error(`Price container ("${PRICE_CONTAINER_SELECTOR}") not found after click and wait.`);
            }
            logToScreen(`Found price container for Order ${orderId} after click.`);

            // 4. Parse prices (Subtotal and Tax are crucial)
            const subtotal = findPriceByLabel(priceContainer, 'Subtotal');
            const extractedTax = findPriceByLabel(priceContainer, 'Tax');

            if (subtotal === null || extractedTax === null) {
                 throw new Error(`Failed to parse critical prices: Subtotal (${subtotal !== null ? formatCurrency(subtotal) : 'Not Found'}) or Tax (${extractedTax !== null ? formatCurrency(extractedTax) : 'Not Found'}).`);
            }
             // Parse others for calculation, default to 0 if not found
             const totalDiscounts = calculateTotalDiscounts(priceContainer);
             const shipping = findPriceByLabel(priceContainer, 'Shipping') || 0; // Default shipping to 0 if not found/parsed


            logToScreen(`[Order ${orderId}] Parsed: Sub=${formatCurrency(subtotal)}, Tax=${formatCurrency(extractedTax)}, Disc=${formatCurrency(totalDiscounts)}, Ship=${formatCurrency(shipping)}`);

            // 5. Calculate GST based on original method (for monetary difference)
            const taxableBase = subtotal + shipping - totalDiscounts;
            const expectedGst = taxableBase * GST_RATE;
            const monetaryDifference = extractedTax - expectedGst; // Actual minus expected

            // 6. Apply the NEW error condition
            // Error only if Actual Tax > (Subtotal * GST Rate)
            const subtotalGstThreshold = subtotal * GST_RATE;
            const isOverchargeError = extractedTax > subtotalGstThreshold;

            logToScreen(`[Order ${orderId}] Calc: Base=${formatCurrency(taxableBase)}, ExpGST=${formatCurrency(expectedGst)}, ActualTax=${formatCurrency(extractedTax)}, Diff=${formatCurrency(monetaryDifference)}`);
            logToScreen(`[Order ${orderId}] Check: SubtotalThreshold=${formatCurrency(subtotalGstThreshold)}. Is Overcharge Error? ${isOverchargeError}`);


            // 7. Prepare result data
            resultData = {
                status: "success",
                orderId: orderId,
                isOverchargeError: isOverchargeError, // The new boolean flag
                monetaryDifference: monetaryDifference, // The calculated monetary difference (can be +/-)
                found: extractedTax, // Actual tax found
                expected: expectedGst, // Expected GST based on full calculation
                subtotalThreshold: subtotalGstThreshold // The threshold used for the error condition
            };
            logToScreen(`Order ${orderId} processed successfully. Overcharge Error: ${isOverchargeError}`);

        } catch (error) {
            logToScreen(`Error processing detail page for Order ${orderId}: ${error.message}`, "ERROR");
            console.error(error);
            resultData.message = error.message || "Error during detail page processing.";
            resultData.status = "error"; // Ensure status is error
        }

        // 8. Store result and close tab
        logToScreen(`Storing result for Order ${orderId}...`);
        await GM_setValue(`gst_result_${orderId}`, resultData);
        logToScreen(`Result stored. Closing tab for Order ${orderId} in 2 seconds...`);
        await sleep(2000);
        GM_closeTab();
    }


    // --- Script Entry Point ---
    // Wrap the entry logic in an immediately invoked async function expression (IIAFE)
    (async function() { // <-- Make the wrapper function async
        try {
            logToScreen(`Script starting on: ${window.location.href}`);
            if (window.location.href.includes('/p/order/index.html')) {
                // Wait a bit longer for dynamic content on list page
                setTimeout(runListPageLogic, 2500);
            } else if (window.location.href.includes('/p/order/detail.html')) {
                 // Check if this tab was likely opened by the script by seeing if its status is pending
                 const urlParams = new URLSearchParams(window.location.search);
                 const orderId = urlParams.get('orderId');
                 if (orderId) {
                     // Use await here instead of .then()
                     const statusInfo = await GM_getValue(`gst_status_${orderId}`); // <-- Use await

                     if (statusInfo && statusInfo.status === 'pending') {
                         logToScreen(`Detail page for Order ${orderId} was opened by script. Proceeding.`);
                         // Detail page logic should ideally already be async if it uses GM_* functions
                         setTimeout(runDetailPageLogic, 1500); // Delay init on detail page
                     } else {
                         // Added more detail to the log message for debugging
                         logToScreen(`Detail page for Order ${orderId} not found in pending status ('${statusInfo?.status}') or not opened by script. Won't process automatically.`, "WARN");
                     }
                 } else {
                     logToScreen("Detail page loaded without an Order ID in URL.", "WARN");
                 }
            } else {
                 logToScreen("Script running on unrecognized page.", "WARN");
            }
        } catch (e) {
             // Log the error stack trace if available for more details
             logToScreen(`Unhandled exception at script entry point! ${e.message}${e.stack ? `\nStack: ${e.stack}` : ''}`, "ERROR");
             console.error(e);
        }
    })();

})();
