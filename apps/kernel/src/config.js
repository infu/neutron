// Get the full URL
var fullUrl = window.location.href;

// Extract the part you need using regular expressions
var match = fullUrl.match(/^https?:\/\/(.*?)\..*$/);

// match[1] contains the extracted part if the regex matched
export const neutron_id = match ? match[1] : false;

if (!neutron_id) console.log("The URL is not in the expected format");
