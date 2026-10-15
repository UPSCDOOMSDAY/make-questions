document.getElementById("generateQCAB").addEventListener("click", async () => {

    const customQuestions = window.customQuestions || [];

    if (customQuestions.length === 0) {
        alert("Add at least one custom question first!");
        return;
    }

    const supabaseClient = window.supabaseClient;

    if (!supabaseClient) {
        alert("Authentication system is not ready. Please refresh the page and try again.");
        return;
    }

    const { data: { session }, error: sessionError } =
        await supabaseClient.auth.getSession();

    if (sessionError || !session) {
        return;
    }

    // ==========================================
    // CHECK PREMIUM ACCESS FIRST
    // ==========================================

    const { data: accessData, error: accessError } =
        await supabaseClient
            .from("user_access")
            .select("access_level, access_expires_at")
            .eq("user_id", session.user.id)
            .maybeSingle();

    if (accessError) {

        console.error(
            "Premium access check error:",
            accessError
        );

        alert(
            "Could not verify your account access. Please try again."
        );

        return;
    }

    const accessLevel =
        String(accessData?.access_level || "free")
            .trim()
            .toLowerCase();

    const accessExpiresAt =
        accessData?.access_expires_at || null;

    const premiumActive =
        (accessLevel === "paid" || accessLevel === "premium") &&
        (
            !accessExpiresAt ||
            new Date(accessExpiresAt).getTime() > Date.now()
        );


    // ==========================================
    // PREMIUM USERS: UNLIMITED GENERATION
    // ==========================================

    if (premiumActive) {

        console.log("Premium user detected - unlimited generation.");

        if (window.updateUsageDisplay) {

            window.updateUsageDisplay(
                0,
                "paid",
                accessExpiresAt
            );

        }

    } else {

        // ==========================================
        // FREE USERS: USE ONE FREE GENERATION
        // ==========================================
        // Free usage is stored directly in user_access.
        // No user_usage table or RPC is required.

        const { data: currentAccess, error: currentAccessError } =
            await supabaseClient
                .from("user_access")
                .select("generations_used")
                .eq("user_id", session.user.id)
                .maybeSingle();

        if (currentAccessError || !currentAccess) {

            console.error(
                "Free generation access fetch error:",
                currentAccessError
            );

            alert(
                "Could not verify your free generation. Please try again."
            );

            return;
        }

        const generationsUsed =
            Number(currentAccess.generations_used || 0);


        // ==========================================
        // NO GENERATIONS LEFT
        // ==========================================

        if (generationsUsed >= 5) {

            if (window.updateUsageDisplay) {

                window.updateUsageDisplay(0);

            }

            alert(
                "You have used all 5 free QCAB generations. Please upgrade to Premium to continue."
            );

            return;
        }


        // ==========================================
        // USE ONE FREE GENERATION
        // ==========================================

        const newGenerationsUsed =
            generationsUsed + 1;

        const { error: updateAccessError } =
            await supabaseClient
                .from("user_access")
                .update({
                    generations_used: newGenerationsUsed
                })
                .eq("user_id", session.user.id);

        if (updateAccessError) {

            console.error(
                "Free generation update error:",
                updateAccessError
            );

            alert(
                "Could not verify your free generation. Please try again."
            );

            return;
        }


        // ==========================================
        // UPDATE FREE COUNTER
        // ==========================================

        if (window.updateUsageDisplay) {

            window.updateUsageDisplay(
                Math.max(
                    0,
                    5 - newGenerationsUsed
                )
            );

        }

    }


    // ==========================================
    // NUMBER QUESTIONS
    // ==========================================

    customQuestions.forEach((q, i) => {

        q.question_number =
            i + 1;

    });


    // ==========================================
    // GENERATE PDF
    // ==========================================

    try {

        await generateQCABPDF(
            customQuestions
        );

    } catch (error) {

        console.error(
            "QCAB generation failed:",
            error
        );


        // ==========================================
        // REFUND ONLY FREE GENERATION
        // ==========================================

        if (!premiumActive) {

            // Refund the consumed generation directly in user_access.

            const { data: refundAccess, error: refundFetchError } =
                await supabaseClient
                    .from("user_access")
                    .select("generations_used")
                    .eq("user_id", session.user.id)
                    .maybeSingle();

            if (refundFetchError || !refundAccess) {

                console.error(
                    "Generation refund fetch failed:",
                    refundFetchError
                );

            } else {

                const currentUsed =
                    Number(refundAccess.generations_used || 0);

                const refundedUsed =
                    Math.max(0, currentUsed - 1);

                const { error: refundError } =
                    await supabaseClient
                        .from("user_access")
                        .update({
                            generations_used: refundedUsed
                        })
                        .eq("user_id", session.user.id);

                if (refundError) {

                    console.error(
                        "Generation refund failed:",
                        refundError
                    );

                }

            }

        }


        // Refresh counter from database

        if (window.refreshUsage) {

            await window.refreshUsage();

        }


        alert(
            premiumActive
                ? "We couldn't generate your QCAB. Please try again."
                : "We couldn't generate your QCAB. Your free generation has been restored. Please try again."
        );

    }

});



// ==========================================
// ANSWER PAGE CALCULATION
// ==========================================

function getAnswerPages(q) {

    const marks =
        Number(q.marks) || 0;

    if (marks === 15)
        return 3;

    if (marks >= 20)
        return 4;

    return 2;
}



// ==========================================
// ESCAPE HTML
// ==========================================

function escapePDFHTML(value) {

    return String(value || "")

        .replace(
            /&/g,
            "&amp;"
        )

        .replace(
            /</g,
            "&lt;"
        )

        .replace(
            />/g,
            "&gt;"
        )

        .replace(
            /"/g,
            "&quot;"
        )

        .replace(
            /'/g,
            "&#039;"
        );

}



// ==========================================
// CHECK RICH QUESTION
// ==========================================

function hasRichQuestion(q) {

    return !!q.question_html &&
        q.question_html.includes("<img");

}



// ==========================================
// WAIT FOR IMAGES
// ==========================================

function waitForImages(container) {

    const images =
        [...container.querySelectorAll("img")];

    return Promise.all(

        images.map(img => {

            if (
                img.complete &&
                img.naturalWidth > 0
            ) {

                return Promise.resolve();

            }

            return new Promise(resolve => {

                img.onload =
                    resolve;

                img.onerror =
                    resolve;

            });

        })

    );

}



// ==========================================
// RENDER QUESTION TO CANVAS
// ==========================================

async function renderQuestionToCanvas(
    q,
    widthPx = 1100
) {

    if (!window.html2canvas) {

        throw new Error(
            "html2canvas is not loaded. Please check your internet connection."
        );

    }

    const host =
        document.createElement("div");

    host.className =
        "pdf-question-render";

    host.style.cssText = [

        "position:fixed",

        "left:-100000px",

        "top:0",

        `width:${widthPx}px`,

        "padding:0",

        "margin:0",

        "background:#fff",

        "color:#111",

        "font-family:Times New Roman, serif",

        "font-size:30px",

        "line-height:1.45",

        "white-space:normal",

        "overflow:visible",

        "z-index:-1"

    ].join(";");

    host.innerHTML =
        q.question_html ||
        escapePDFHTML(
            q.question_text || ""
        );

    host.querySelectorAll("img")
        .forEach(img => {

            img.style.width =
                "100%";

            img.style.maxWidth =
                "100%";

            img.style.height =
                "auto";

            img.style.display =
                "block";

            img.style.margin =
                "3px 0";

        });

    document.body.appendChild(host);

    try {

        await waitForImages(
            host
        );

        return await window.html2canvas(

            host,

            {

                backgroundColor:
                    "#ffffff",

                scale:
                    2,

                useCORS:
                    true,

                logging:
                    false

            }

        );

    } finally {

        host.remove();

    }

}



// ==========================================
// ADD CANVAS IMAGE
// ==========================================

function addCanvasImage(

    doc,
    canvas,
    x,
    y,
    maxWidthMm,
    maxHeightMm = Infinity

) {

    let widthMm =
        maxWidthMm;

    let heightMm =
        widthMm *
        canvas.height /
        canvas.width;

    if (
        heightMm >
        maxHeightMm
    ) {

        const ratio =
            maxHeightMm /
            heightMm;

        widthMm *=
            ratio;

        heightMm =
            maxHeightMm;

    }

    const imageData =
        canvas.toDataURL(
            "image/png"
        );

    doc.addImage(

        imageData,

        "PNG",

        x,

        y,

        widthMm,

        heightMm,

        undefined,

        "FAST"

    );

    return {

        width:
            widthMm,

        height:
            heightMm

    };

}



// ==========================================
// GENERATE QCAB PDF
// ==========================================

async function generateQCABPDF(
    questions
) {

    const { jsPDF } =
        window.jspdf;

    const doc =
        new jsPDF({

            unit:
                "mm",

            format:
                "a4"

        });

    const pageHeight =
        297;

    const leftMargin =
        25;

    const rightMargin =
        185;

    const topMargin =
        15;

    const bottomMargin =
        282;

    doc.setFont(
        "Times",
        "Roman"
    );

    doc.setFontSize(
        12
    );


    // ==========================================
    // PART 1: QUESTION LISTING
    // ==========================================

    // DETAILS BOX ON THE FIRST PAGE ONLY — MATCH GS PDF LAYOUT
    const detailsBoxX = leftMargin;
    const detailsBoxY = topMargin;
    const detailsBoxWidth = rightMargin - leftMargin;
    const detailsBoxHeight = 50;

    doc.setLineWidth(0.3);
    doc.rect(
        detailsBoxX,
        detailsBoxY,
        detailsBoxWidth,
        detailsBoxHeight
    );

    doc.setFontSize(10);

    // ROW 1: NAME
    doc.text("Name:", 28, 21);
    doc.line(42, 22, 182, 22);

    // ROW 2: TOPIC
    doc.text("Topic:", 28, 31);
    doc.line(42, 32, 182, 32);

    // ROW 3: NUMBER OF QUESTIONS + ESTIMATED TIME
    doc.text("No of questions:", 28, 41);
    doc.line(57, 42, 95, 42);

    doc.text("Estimated time:", 105, 41);
    doc.line(133, 42, 182, 42);

    // ROW 4: START TIME + FINISH TIME
    doc.text("Start Time:", 28, 51);
    doc.line(49, 52, 95, 52);

    doc.text("Finish Time:", 105, 51);
    doc.line(129, 52, 182, 52);

    // ROW 5: DATE
    doc.text("Date:", 28, 61);
    doc.line(39, 62, 95, 62);

    doc.setFontSize(12);

    // Keep the same 3.5 cm gap below the details box as the GS PDF
    let currentY = topMargin + detailsBoxHeight + 35;

    const localWidth = rightMargin - leftMargin + 4;
    const lineHeight = 6;

    for (const q of questions) {

        if (hasRichQuestion(q)) {

            try {
                const canvas = await renderQuestionToCanvas(q);
                const imageHeight = Math.min(
                    42,
                    localWidth * canvas.height / canvas.width
                );

                const meta = `[${q.marks} M${q.word_limit ? ` / ${q.word_limit} W` : ""}]`;
                const metaLines = doc.splitTextToSize(meta, 35);
                const totalHeight = Math.max(
                    imageHeight,
                    metaLines.length * lineHeight
                ) + lineHeight;

                if (currentY + totalHeight > pageHeight - 15) {
                    doc.addPage();
                    currentY = topMargin;
                }

                addCanvasImage(
                    doc,
                    canvas,
                    leftMargin + 2,
                    currentY,
                    localWidth,
                    42
                );

                doc.text(`${q.question_number}.`, leftMargin - 10, currentY + 5);
                doc.setFontSize(9);
                doc.text(metaLines, rightMargin + 2, currentY + 5);
                doc.setFontSize(12);
                currentY += totalHeight + 3;

            } catch (error) {
                console.error("Rich question rendering failed:", error);

                const fallback = `${q.question_text || ""}   [${q.marks} M${q.word_limit ? ` / ${q.word_limit} W` : ""}]`;
                const splitText = doc.splitTextToSize(fallback, localWidth);
                const totalHeight = splitText.length * lineHeight + lineHeight;

                if (currentY + totalHeight > pageHeight - 15) {
                    doc.addPage();
                    currentY = topMargin;
                }

                doc.text(`${q.question_number}.`, leftMargin - 10, currentY);
                doc.text(splitText, leftMargin + 2, currentY);
                currentY += totalHeight;
            }

        } else {

            const qText = `${q.question_text || ""}   [${q.marks} M${q.word_limit ? ` / ${q.word_limit} W` : ""}]`;
            const splitText = doc.splitTextToSize(qText, localWidth);
            const totalHeight = splitText.length * lineHeight + lineHeight;

            if (currentY + totalHeight > pageHeight - 15) {
                doc.addPage();
                currentY = topMargin;
            }

            doc.text(`${q.question_number}.`, leftMargin - 10, currentY);
            doc.text(splitText, leftMargin + 2, currentY);
            currentY += totalHeight;
        }
    }


    // ==========================================
    // FIRST PAGE FOOTER
    // ==========================================

    doc.setFontSize(
        9
    );

    doc.text(

        "Made by DoomsDay QCAB Generator - for more info contact : cds2gc@gmail.com",

        105,

        288,

        {

            align:
                "center"

        }

    );

    doc.setFontSize(
        22
    );


    // ==========================================
    // PART 2: QCAB ANSWER PAGES
    // ==========================================

    // Match GS PDF answer-page layout
    const answerLeftMargin = 15;
    const answerRightMargin = 195;
    const answerTopMargin = 0;
    const answerBottomMargin = pageHeight;
    const answerContentTop = 10;

    for (const q of questions) {

        const pagesNeeded = getAnswerPages(q);

        for (let p = 0; p < pagesNeeded; p++) {

            doc.addPage();
            doc.setLineWidth(0.3);

            // Full-height vertical lines, 15 mm from each page edge
            doc.line(
                answerLeftMargin,
                answerTopMargin,
                answerLeftMargin,
                answerBottomMargin
            );
            doc.line(
                answerRightMargin,
                answerTopMargin,
                answerRightMargin,
                answerBottomMargin
            );

            // ==========================================
            // FIRST ANSWER PAGE
            // ==========================================

            if (p === 0) {

                doc.setFontSize(12);

                // Question number outside the left vertical line
                doc.text(
                    `Q. ${q.question_number}`,
                    answerLeftMargin - 10,
                    answerContentTop + 5
                );

                // Keep question text inside the vertical lines
                const localQuestionWidth = answerRightMargin - answerLeftMargin - 14;
                let questionBottom = answerContentTop + 5;

                if (hasRichQuestion(q)) {
                    try {
                        const canvas = await renderQuestionToCanvas(q);
                        const image = addCanvasImage(
                            doc,
                            canvas,
                            answerLeftMargin + 2,
                            answerContentTop,
                            localQuestionWidth,
                            55
                        );
                        questionBottom = answerContentTop + 14 + image.height;
                    } catch (error) {
                        console.error("Rich question rendering failed:", error);
                        const splitText = doc.splitTextToSize(
                            q.question_text || "",
                            localQuestionWidth
                        );
                        doc.setFontSize(12);
                        doc.text(splitText, answerLeftMargin + 2, answerContentTop + 5);
                        questionBottom = answerContentTop + 5 + splitText.length * 6;
                    }
                } else {
                    const splitText = doc.splitTextToSize(
                        q.question_text || "",
                        localQuestionWidth
                    );
                    doc.setFontSize(12);
                    doc.text(splitText, answerLeftMargin + 2, answerContentTop + 5);
                    questionBottom = answerContentTop + 5 + splitText.length * 6;
                }

                // Marks and year stacked on the right, just outside the right line
                doc.setFontSize(8);
                if (q.marks != null) {
                    doc.text(`${q.marks} M`, answerRightMargin + 2, answerContentTop + 5);
                }
                if (q.year != null && String(q.year).trim() !== "") {
                    doc.text(String(q.year), answerRightMargin + 2, answerContentTop + 10);
                }

                // Preserve normal black text for the writing area
                if (questionBottom < answerBottomMargin - 4) {
                    doc.setTextColor(0, 0, 0);
                }

            } else {

                // ==========================================
                // MARGIN INSTRUCTION — TWO WORDS PER ROW
                // ==========================================

                doc.setFontSize(6);
                const marginInstruction = [
                    "Candidates",
                    "must not",
                    "write on",
                    "margin"
                ];

                // Keep the margin instruction horizontal (normal orientation).
                doc.text(
                    marginInstruction,
                    197,
                    15,
                    {
                        lineHeightFactor: 1.3
                    }
                );
            }
        }
    }

    // ==========================================
    // SAVE PDF
    // ==========================================

    window.generatedPDF = doc;
    doc.save("QCAB.pdf");
}
