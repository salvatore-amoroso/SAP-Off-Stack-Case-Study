CLASS lcx_bl_poll DEFINITION INHERITING FROM cx_static_check.
  PUBLIC SECTION.
    DATA code TYPE string READ-ONLY.
    METHODS constructor IMPORTING code TYPE string.
ENDCLASS.

CLASS lcl_bl_clock DEFINITION.
  PUBLIC SECTION.
    METHODS constructor IMPORTING runtime TYPE REF TO if_abap_runtime OPTIONAL.
    METHODS now RETURNING VALUE(microseconds) TYPE int8.
  PRIVATE SECTION.
    DATA timer TYPE REF TO if_abap_runtime.
    DATA previous TYPE i.
    DATA accumulated TYPE int8.
ENDCLASS.
