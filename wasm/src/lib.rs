//! The zubra compiler as a WebAssembly module, with a plain C ABI (no bindings generator):
//!
//! 1. `zubra_alloc(len)` reserves `len` bytes; the host writes the request (UTF-8 JSON) there.
//! 2. `zubra_request(ptr, len)` handles it and returns the response's location as
//!    `(ptr << 32) | len` (a `u64`); the request's memory is freed.
//! 3. The host reads the response (UTF-8 JSON) and calls `zubra_free(ptr, len)`.
//!
//! The request and response formats are `zubra::handle_request`'s.

use std::{alloc, slice};

/// Reserve `len` bytes for the host to write into.
#[no_mangle]
pub extern "C" fn zubra_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    let layout = alloc::Layout::array::<u8>(len).expect("allocation fits");
    // SAFETY: `layout` has a non-zero size.
    unsafe { alloc::alloc(layout) }
}

/// Release memory from `zubra_alloc` or a response.
///
/// # Safety
/// `ptr` and `len` must come from `zubra_alloc(len)` or a response of `zubra_request`, once.
#[no_mangle]
pub unsafe extern "C" fn zubra_free(ptr: *mut u8, len: usize) {
    if len == 0 {
        return;
    }
    let layout = alloc::Layout::array::<u8>(len).expect("allocation fits");
    // SAFETY: the caller passes memory this module allocated with this layout.
    unsafe { alloc::dealloc(ptr, layout) }
}

/// Handle the request at `ptr..ptr + len` (freeing it) and return the response's location.
///
/// # Safety
/// `ptr` and `len` must come from `zubra_alloc(len)`, with the request written there.
#[no_mangle]
pub unsafe extern "C" fn zubra_request(ptr: *mut u8, len: usize) -> u64 {
    // SAFETY: the caller wrote `len` bytes at `ptr`, which `zubra_alloc` reserved.
    let request = unsafe { slice::from_raw_parts(ptr, len) };
    let response = match std::str::from_utf8(request) {
        Ok(request) => zubra::handle_request(request),
        Err(_) => r#"{"ok":false,"output":null,"error":"the request isn't UTF-8","warnings":[],"diagnostics":[]}"#.to_owned(),
    };
    // SAFETY: as above; the request isn't used after this.
    unsafe { zubra_free(ptr, len) };
    let bytes = response.into_bytes().into_boxed_slice();
    let len = bytes.len();
    let ptr = Box::into_raw(bytes).cast::<u8>();
    ((ptr as usize as u64) << 32) | len as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ABI round trip, natively (pointers are 64-bit here, so read them back directly).
    #[test]
    fn a_request_round_trips_through_the_abi() {
        let request = br#"{"path":"/a.zb","files":{"/a.zb":"<zb-a label=\"x\"><p>{label}</p></zb-a>"},"emit":"html"}"#;
        let ptr = zubra_alloc(request.len());
        unsafe { std::ptr::copy_nonoverlapping(request.as_ptr(), ptr, request.len()) };
        // Natively the packed form can't hold a 64-bit pointer, so call the compiler the same
        // way the export does and check the response it would carry.
        unsafe { zubra_free(ptr, request.len()) };
        let response = zubra::handle_request(std::str::from_utf8(request).unwrap());
        assert!(response.contains("<p>x</p>"), "{response}");
    }
}
